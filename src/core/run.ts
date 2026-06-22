import { existsSync } from "node:fs";

import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import * as bun from "bun";

import { resolveAcpCommand, resolveAcpxCommand } from "../agent/acpx.ts";
import type { AgentDriver, AgentRunResult, RunOptions } from "../agent/driver.ts";
import type { Report, ReportStatus } from "../agent/report.ts";
import { assertKnownProject } from "../config/registry.ts";
import type { Config, Project, Registry } from "../config/schema.ts";
import type { Issue, JobKind, Resolved } from "../model/types.ts";
import { resolve, resolvePolicy, resolvePr } from "../resolve/precedence.ts";
import type { Comment, Tracker } from "../trackers/tracker.ts";
import { renderContinuation } from "./continuation.ts";
import { TrackerCommentSink } from "./decision-receipt.ts";
import { DECISION_HOLD_MESSAGE, isDecisionHeld } from "./decision.ts";
import {
    buildDecisionEvent,
    CompositeSink,
    LocalNdjsonSink,
    readDecisionEvents,
    resolveDecisionsDir,
} from "./decisionlog.ts";
import type { DecisionSink } from "./decisionlog.ts";
import { isThinIssue, resolveMinBodyChars, THIN_ISSUE_MESSAGE } from "./inputquality.ts";
import { injectAcpxMcp, nodeMcpFs } from "./mcp.ts";
import type { McpFs, McpServer } from "./mcp.ts";
import { escalationDetail, notifyEscalation } from "./notify.ts";
import type { Notifier } from "./notify.ts";
import { computeChangedFiles, defaultPolicyExec, defaultPolicyReader, evaluatePolicy } from "./policy.ts";
import type { PolicyExec, PolicyReader, PolicyResult } from "./policy.ts";
import { closePr, detectBaseBranch, editPr, hasCommits, markReady, openDraftPr } from "./pr.ts";
import type { PrRef } from "./pr.ts";
import {
    derivePreflightPaths,
    findHistoricalOverlaps,
    formatHistoricalOverlap,
    PREFLIGHT_BLOCK_MESSAGE,
} from "./preflight.ts";
import type { PromptResolveDeps, PromptSet } from "./prompts.ts";
import { loadDecisionReceiptPrompt, renderContract, renderLinkedContext, renderTask } from "./prompts.ts";
import {
    defaultGateExec,
    pinBaselineTests,
    resolveBaselineTestGlobs,
    resolveMaxRework,
    resolveQualityGate,
    runQualityGate,
} from "./qualitygate.ts";
import type { GateExec } from "./qualitygate.ts";
import { deleteRecord, loadRecord, resolveRunsDir, saveRecord, systemClock } from "./runstore.ts";
import type { Clock, RunRecord, RunStoreFs } from "./runstore.ts";
import { formatTelemetryLine, resolveTelemetryInComment } from "./runsview.ts";
import { bunExec, createWorktree, removeWorktree, resolveWorktreeDir, sanitizeKey } from "./worktree.ts";
import type { Exec } from "./worktree.ts";
import { applyReport, buildCommentBody, defaultDoneState } from "./writeback.ts";
import type { WritebackResult } from "./writeback.ts";

const IN_PROGRESS_STATE = "In Progress";
const DEFAULT_MANUAL_MOVE_POLL_MS = 15000;
const SECONDS_PER_MINUTE = 60;

// Fallback for programmatic callers that pass no `promptResolveDeps`: resolves
// every prompt candidate as missing, so the compiled-in template wins without
// touching the filesystem. cli.ts always supplies real deps.
const COMPILED_ONLY_RESOLVE_DEPS: PromptResolveDeps = {
    configDir: "",
    exists: () => false,
    home: "",
    read: () => "",
};

export type Logger = (msg: string) => void;

/**
 * The default decision sink: the durable NDJSON log, paired (unless
 * `decisions.comment === false`) with a best-effort tracker receipt comment.
 * Ordered `[local, tracker]` so the audit write lands before the ephemeral
 * receipt. Pure and dependency-injected so the gate is unit-testable.
 */
export function buildDefaultDecisionSink(
    config: Config,
    tracker: Tracker,
    issue: Issue,
    runsFs: RunStoreFs | undefined,
    receiptTemplate: string,
    log: Logger,
): DecisionSink {
    const local = new LocalNdjsonSink(resolveDecisionsDir(config.decisions?.dir), runsFs);
    if (config.decisions?.comment === false) {
        return local;
    }
    return new CompositeSink([local, new TrackerCommentSink(tracker, issue, receiptTemplate, log)]);
}

/**
 * A human has pulled an issue out of beflow's hands when its CURRENT state group
 * is not `started`. beflow's own run states (In Progress / Needs Input / In
 * Review) are all `started`, so in the normal flow this is false — it only turns
 * true when a human drags the card to Backlog/Todo/Done/Cancelled mid-run.
 */
export function isPulledByHuman(issue: Issue): boolean {
    return issue.state.group !== "started";
}

async function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export interface ResolvedRun {
    issue: Issue;
    project: Project;
    resolved: Resolved;
}

function projectKeyOf(issueKey: string): string {
    const dash = issueKey.lastIndexOf("-");
    if (dash === -1) {
        throw new Error(`beflow: malformed issue key "${issueKey}"`);
    }
    return issueKey.slice(0, dash);
}

export async function resolveRun(
    key: string,
    cli: Partial<Resolved>,
    config: Config,
    registry: Registry,
    tracker: Tracker,
): Promise<ResolvedRun> {
    const projectKey = projectKeyOf(key);
    const project = assertKnownProject(registry, projectKey);

    const issue = await tracker.getIssue(key);

    const resolved = resolve({
        cli,
        global: config,
        issue: {
            areas: issue.areas,
            state: { group: issue.state.group },
            type: issue.type,
        },
        meta: tracker.readMetadata(issue),
        project,
    });

    return { issue, project, resolved };
}

interface ManualMovePoller {
    stop: () => void;
    /** Resolves when the poll loop has fully settled. */
    settled: Promise<void>;
}

/**
 * While an autonomous run is live, poll the board on an interval; if a human pulls
 * the issue out of the started group, cancel the agent cooperatively so the run
 * ends early instead of burning to completion. The end-of-run re-read in runIssue
 * is what authoritatively decides to skip writeback — this only shortens the run.
 */
function startManualMovePoller(args: {
    key: string;
    cwd: string;
    acpCommand: string;
    pollMs: number;
    sleep: (ms: number) => Promise<void>;
    tracker: Tracker;
    driver: AgentDriver;
    log: Logger;
}): ManualMovePoller {
    // Mutable flags live on an object written by both `stop()` and the loop. They are
    // Read through `isStopped()` so the boolean isn't narrowed to its initial literal
    // Across the `await` points (where `stop()` may have fired concurrently).
    const state = { stopped: false };
    function isStopped(): boolean {
        return state.stopped;
    }
    const loop = (async (): Promise<void> => {
        while (!isStopped()) {
            await args.sleep(args.pollMs);
            if (isStopped()) {
                break;
            }
            const live = await args.tracker.getIssue(args.key);
            if (isStopped()) {
                break;
            }
            if (isPulledByHuman(live)) {
                args.log(`beflow: ${args.key} — manual move detected (now ${live.state.name}); cancelling the agent`);
                await args.driver.cancel(args.key, args.cwd, args.acpCommand);
                break;
            }
        }
    })();
    return {
        settled: loop,
        stop: () => {
            state.stopped = true;
        },
    };
}

async function moveToInProgress(tracker: Tracker, issue: Issue): Promise<void> {
    if (issue.state.group === "started") {
        return;
    }
    await tracker.updateState(issue, IN_PROGRESS_STATE);
}

/**
 * Re-read the live issue at the end of a run and, if a human pulled the card out
 * of the started group, yield STATE authority to them: skip writeback, preserve
 * the agent's report as a comment, run any extra cleanup, and delete the record.
 * Returns true when it yielded (the caller must stop and return early), false when
 * the issue is still ours and the normal writeback path should proceed.
 */
async function yieldToManualMove(args: {
    tracker: Tracker;
    key: string;
    issue: Issue;
    report: Report | null;
    runsDir: string;
    runsFs?: RunStoreFs;
    log: Logger;
    cleanup?: () => Promise<void>;
}): Promise<boolean> {
    const fresh = await args.tracker.getIssue(args.key);
    if (!isPulledByHuman(fresh)) {
        return false;
    }
    if (args.report !== null) {
        await args.tracker.comment(args.issue, buildCommentBody(args.report));
    }
    if (args.cleanup !== undefined) {
        await args.cleanup();
    }
    deleteRecord(args.runsDir, args.key, args.runsFs);
    args.log(`beflow: ${args.key} — yielded to manual move (now ${fresh.state.name}); writeback skipped`);
    return true;
}

// Fetch + render the linked context (parent epic + attachments) for the agent
// Task. Fully degrade-safe: disabled or any fetch failure yields "" so a run
// Never breaks on missing context.
async function gatherLinkedContext(tracker: Tracker, issue: Issue, enabled: boolean, log: Logger): Promise<string> {
    if (!enabled) {
        return "";
    }
    try {
        return renderLinkedContext(await tracker.issueContext(issue));
    } catch (err) {
        log(
            `beflow: ${issue.key} — linked-context fetch failed (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
        );
        return "";
    }
}

export interface RunIssueDeps {
    tracker: Tracker;
    driver: AgentDriver;
    config: Config;
    registry: Registry;
    prompts: PromptSet;
    git?: Exec;
    log?: Logger;
    runsFs?: RunStoreFs;
    clock?: Clock;
    fresh?: boolean;
    pathExists?: (p: string) => boolean;
    preResolved?: ResolvedRun;
    continuation?: string;
    sleep?: (ms: number) => Promise<void>;
    manualMovePollMs?: number;
    notify?: Notifier;
    mcpServers?: McpServer[];
    mcpFs?: McpFs;
    gateExec?: GateExec;
    prExec?: Exec;
    policyExec?: PolicyExec;
    policyReader?: PolicyReader;
    decisionSink?: DecisionSink;
    promptResolveDeps?: PromptResolveDeps;
}

const RESUME_STATUSES: ReadonlySet<RunRecord["status"]> = new Set([
    "in_progress",
    "needs_input",
    "blocked",
    "done",
    "failed",
]);

const IN_REVIEW_INSTRUCTION =
    "This work item is now **In Review**. To request changes: add the `changes-requested` label **and** leave a comment describing what to change. Adding the label without a comment will not start a rework — beflow will ask you for the description.";

// Appended only in runOpen: tells the agent to exit its interactive session so beflow can resume.
export const OPEN_SESSION_TRAILER =
    "\n\n---\n\nYou are running inside beflow's supervised `--open` mode, in the user's own interactive agent session — they are present and supervising. If anything about the task above is unclear, just ask them directly. When you have finished, end your turn with a brief status summary, then tell the user to close this agent session (for example `/exit` or Ctrl+C) so beflow can resume and record the outcome. Do not stop silently.";

async function postInReviewInstructionOnce(tracker: Tracker, issue: Issue, log: Logger): Promise<void> {
    const sentinel = "To request changes: add the `changes-requested` label";
    const comments = await tracker.listComments(issue);
    if (comments.some((c) => c.isBot && c.body.includes(sentinel))) {
        return;
    }
    await tracker.comment(issue, IN_REVIEW_INSTRUCTION);
    log(`beflow: ${issue.key} → In Review; posted change-request instructions`);
}

function beflowPrTitle(issue: Issue): string {
    return `[beflow] ${issue.key}: ${issue.title}`;
}

function beflowPrBody(issue: Issue, summary?: string): string {
    const base = `Automated implementation of ${issue.key} by beflow.`;
    if (summary !== undefined && summary.trim() !== "") {
        return `${base}\n\n${summary.trim()}`;
    }
    return base;
}

export interface RunResult {
    issue: Issue;
    resolved: Resolved;
    cwd: string;
    result: AgentRunResult;
    applied?: WritebackResult;
    parked?: "decision" | "thin" | "preflight";
}

export async function runIssue(key: string, cli: Partial<Resolved>, deps: RunIssueDeps): Promise<RunResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const clock = deps.clock ?? systemClock;
    const pathExists = deps.pathExists ?? existsSync;
    const { issue, resolved } =
        deps.preResolved ?? (await resolveRun(key, cli, deps.config, deps.registry, deps.tracker));

    const runsDir = resolveRunsDir(deps.config.runs?.dir);
    const baseDir = resolveWorktreeDir(deps.config.worktrees?.dir);
    const useWorktree = resolved.runMode === "autonomous" && deps.git !== undefined;

    let prior = loadRecord(runsDir, key, deps.runsFs);
    if (deps.fresh === true) {
        if (prior !== null && useWorktree && deps.git !== undefined) {
            try {
                await removeWorktree(resolved.repoPath, prior.cwd, deps.git);
                log(`beflow: removed worktree at ${prior.cwd} (--fresh)`);
            } catch {
                // Best-effort: a stale or already-removed worktree must not block a fresh run
            }
        }
        deleteRecord(runsDir, key, deps.runsFs);
        prior = null;
    }

    // INPUT-QUALITY GATE (opt-in): on a FRESH autonomous dispatch only — not a resume,
    // Not a continuation (rework/answered) — a too-thin description is parked to Needs
    // Input with a comment, BEFORE any worktree is created or the board is claimed, so
    // We never burn an agent run on an issue an agent can't act on safely.
    const hasResumablePrior = prior !== null && RESUME_STATUSES.has(prior.status) && pathExists(prior.cwd);
    const isFreshDispatch = deps.continuation === undefined && !hasResumablePrior;
    // Resolved once and shared by the pre-worktree preflight (below) and the
    // Authoritative post-diff gate (after the run): one resolver, two call points.
    const resolvedPolicy = resolvePolicy(deps.config, deps.registry, projectKeyOf(key));
    if (isFreshDispatch) {
        // DECISION GATE (always on; the per-issue label IS the opt-in): an explicit
        // `needs-decision` label outranks the thin heuristic, so it is checked first.
        // The issue is parked to Needs Input and escalated, and a hold record is written
        // So watch's release pass can detect (and ONLY) this hold; the human makes the
        // Call by removing the label, which releases the issue back to Todo. Like the
        // Thin gate, this lives in runIssue (autonomous) only — runSupervised/runOpen
        // Have a human present who can make the call without parking.
        if (isDecisionHeld(issue.labels)) {
            const report: Report = { status: "needs_input", summary: DECISION_HOLD_MESSAGE };
            const applied = await applyReport(deps.tracker, issue, report, resolved.jobKind);
            saveRecord(
                runsDir,
                {
                    agent: resolved.agent,
                    cwd: resolved.repoPath,
                    heldReason: "decision",
                    jobKind: resolved.jobKind,
                    key,
                    repoPath: resolved.repoPath,
                    runMode: resolved.runMode,
                    sessionName: key,
                    status: "needs_input",
                    tracker: deps.config.tracker,
                    updatedAt: clock(),
                },
                deps.runsFs,
            );
            await notifyEscalation(deps.notify, issue, "needs_input", "decision-gate: awaiting human decision");
            log(`beflow: ${key} held for human decision (needs-decision label) → Needs Input`);
            return {
                applied,
                cwd: resolved.repoPath,
                issue,
                parked: "decision",
                resolved,
                result: { exitCode: 0, raw: [], report, stream: { assistantText: "", toolCalls: [] }, timedOut: false },
            };
        }

        const minBodyChars = resolveMinBodyChars(deps.config, deps.registry, projectKeyOf(key));
        if (isThinIssue(issue.body, minBodyChars)) {
            const report: Report = { status: "needs_input", summary: THIN_ISSUE_MESSAGE };
            const applied = await applyReport(deps.tracker, issue, report, resolved.jobKind);
            await notifyEscalation(deps.notify, issue, "needs_input", "input-quality: thin description");
            log(`beflow: ${key} parked: thin description (< ${String(minBodyChars)} chars) → Needs Input`);
            return {
                applied,
                cwd: resolved.repoPath,
                issue,
                parked: "thin",
                resolved,
                result: {
                    exitCode: 0,
                    raw: [],
                    report,
                    stream: { assistantText: "", toolCalls: [] },
                    timedOut: false,
                },
            };
        }

        // PRE-WORKTREE PREFLIGHT (conservative): under the SAME engage conditions as
        // The authoritative post-diff gate (autonomous implement run; policy active),
        // Run that policy against the COARSE file paths the issue declares, before any
        // Worktree is built. Short-circuit to Needs Input ONLY on a confident `block`
        // — a require_approval/allow proceeds, an issue that declares no paths proceeds,
        // And the post-diff gate over the real diff stays authoritative for everything.
        if (
            resolved.runMode === "autonomous" &&
            resolved.jobKind === "implement" &&
            resolvedPolicy.evaluator !== "off"
        ) {
            const coarsePaths = derivePreflightPaths(issue.title, issue.body);
            if (coarsePaths.length > 0) {
                const decision = await evaluatePolicy(
                    {
                        agent: resolved.agent,
                        baseBranch: "",
                        changedFiles: coarsePaths,
                        issueKey: key,
                        jobKind: resolved.jobKind,
                        repo: resolved.repo,
                    },
                    resolvedPolicy,
                    deps.policyExec ?? defaultPolicyExec,
                    resolved.repoPath,
                    deps.policyReader ?? defaultPolicyReader,
                );
                if (decision.decision === "block") {
                    const report: Report = { status: "needs_input", summary: PREFLIGHT_BLOCK_MESSAGE };
                    const applied = await applyReport(deps.tracker, issue, report, resolved.jobKind);
                    await notifyEscalation(
                        deps.notify,
                        issue,
                        "needs_input",
                        `preflight: declared scope hits a policy block (${decision.reason})`,
                    );
                    log(`beflow: ${key} parked: preflight policy block on declared scope → Needs Input`);
                    return {
                        applied,
                        cwd: resolved.repoPath,
                        issue,
                        parked: "preflight",
                        resolved,
                        result: {
                            exitCode: 0,
                            raw: [],
                            report,
                            stream: { assistantText: "", toolCalls: [] },
                            timedOut: false,
                        },
                    };
                }

                // PREDICTIVE PREFLIGHT (advisory; BEFLOW-18): the live gate above is
                // Authoritative — this never blocks. Consult the durable decision log and,
                // When the declared scope overlaps paths a PRIOR run in the SAME project sent
                // To block/require_approval, log a heads-up and proceed. Project scoping lives
                // Here (not in preflight.ts) to avoid a run.ts import cycle. A missing/partial
                // Log yields [] from readDecisionEvents, so this degrades to a no-op.
                const decisionDir = resolveDecisionsDir(deps.config.decisions?.dir);
                const events = readDecisionEvents(decisionDir, deps.runsFs);
                const project = projectKeyOf(key);
                const scopedEvents = events.filter((event) => projectKeyOf(event.key) === project);
                for (const overlap of findHistoricalOverlaps(scopedEvents, coarsePaths)) {
                    log(formatHistoricalOverlap(overlap, key));
                }
            }
        }
    }

    let cwd = resolved.repoPath;
    let branch: string | undefined;
    let isResume = false;
    let worktreeCreated = false;

    if (useWorktree) {
        if (hasResumablePrior && prior !== null) {
            ({ cwd } = prior);
            ({ branch } = prior);
            isResume = true;
            log(`beflow: resuming ${key} in existing worktree at ${cwd}`);
        } else {
            const git = deps.git;
            if (git === undefined) {
                throw new Error(`beflow: ${key} requires git for worktree creation but none was provided`);
            }
            cwd = await createWorktree(resolved.repoPath, key, git, baseDir);
            branch = `beflow/${sanitizeKey(key)}`;
            worktreeCreated = true;
            log(`beflow: created worktree at ${cwd}`);
        }
    }

    if (isResume && prior !== null && prior.tracker !== undefined && prior.tracker !== deps.config.tracker) {
        throw new Error(
            `beflow: ${key} was started under tracker "${prior.tracker}"; config now uses "${deps.config.tracker}". Finish it under the original tracker, or re-run with --fresh to restart.`,
        );
    }

    const effectiveAgent = isResume && prior !== null ? prior.agent : resolved.agent;
    const effectiveJobKind = isResume && prior !== null ? prior.jobKind : resolved.jobKind;
    const effectiveRunMode = isResume && prior !== null ? prior.runMode : resolved.runMode;
    const effectiveRepoPath =
        isResume && prior !== null && prior.repoPath !== undefined ? prior.repoPath : resolved.repoPath;

    // BEFLOW-OWNED PR (opt-in): when the project resolves PR ownership to `beflow`,
    // The agent only pushes its branch — beflow opens/enriches/marks-ready the PR and
    // Runs the post-run policy gate. This only engages for an autonomous implement run
    // With a worktree branch; every other shape keeps the agent-owned behavior.
    const resolvedPr = resolvePr(deps.config, deps.registry, projectKeyOf(key));
    const beflowOwned =
        resolvedPr.owner === "beflow" && useWorktree && effectiveJobKind === "implement" && branch !== undefined;

    // attempts counts CONSECUTIVE crash resumes only. A fresh dispatch resets to 0,
    // and a human-driven re-dispatch (rework/answered) passes a continuation, so it
    // also resets to 0 — only an unattended crash-resume increments the streak.
    const isCrashResume = isResume && deps.continuation === undefined;
    const attempts = isCrashResume ? (prior?.attempts ?? 0) + 1 : 0;

    const record: RunRecord = {
        key,
        agent: effectiveAgent,
        attempts,
        cwd,
        ...(branch !== undefined ? { branch } : {}),
        sessionName: key,
        jobKind: effectiveJobKind,
        runMode: effectiveRunMode,
        status: "in_progress",
        updatedAt: clock(),
        tracker: prior?.tracker ?? deps.config.tracker,
        repoPath: effectiveRepoPath,
    };
    // RECORD-FIRST: the record is the claim. Write it before touching the board so a
    // crash in the gap can't leave an In-Progress issue with no record (orphan window).
    saveRecord(runsDir, record, deps.runsFs);

    await moveToInProgress(deps.tracker, issue);
    if (deps.config.assignee !== undefined) {
        await deps.tracker.assign(issue, deps.config.assignee);
    }

    const acpCommand = resolveAcpCommand(effectiveAgent, deps.config.agents[effectiveAgent]);

    // Inject the translated `.mcp.json` as a managed `.acpxrc.json` into the agent
    // Cwd so acpx forwards the servers to ACP `session/new`. The cleanup restores
    // The cwd in the finally that wraps the whole agent run (even on throw/timeout).
    const mcpCleanup =
        deps.mcpServers !== undefined && deps.mcpServers.length > 0
            ? injectAcpxMcp(cwd, deps.mcpServers, deps.mcpFs ?? nodeMcpFs)
            : undefined;

    const baseTask =
        renderTask(deps.prompts, issue, resolved.repo) +
        (await gatherLinkedContext(deps.tracker, issue, deps.config.linkedContext !== false, log));
    const task =
        deps.continuation !== undefined
            ? `${deps.continuation}\n\n${baseTask}`
            : isResume
              ? `Resuming work item ${key}; you have prior context in this session — continue from where you left off and finish, then emit the report block.\n\n${baseTask}`
              : baseTask;

    const sleep = deps.sleep ?? realSleep;
    const pollMs = deps.manualMovePollMs ?? DEFAULT_MANUAL_MOVE_POLL_MS;
    const poller =
        deps.config.onManualMove === "abort"
            ? startManualMovePoller({
                  acpCommand,
                  cwd,
                  driver: deps.driver,
                  key,
                  log,
                  pollMs,
                  sleep,
                  tracker: deps.tracker,
              })
            : undefined;

    const maxRunMinutes = deps.registry.projects[projectKeyOf(key)]?.limits?.maxRunMinutes ?? 0;

    // The same persistent ACP session is reused for the initial dispatch and for the
    // Quality-gate auto-rework re-prompt below; only the `task` text differs.
    function buildRunOptions(runTask: string): RunOptions {
        return {
            acpCommand,
            contract: renderContract(deps.prompts, effectiveJobKind, issue, resolved.repo, beflowOwned),
            cwd,
            nonInteractive: "fail",
            runMode: "autonomous",
            sessionKey: key,
            task: runTask,
            ...(maxRunMinutes > 0 ? { timeoutSeconds: maxRunMinutes * SECONDS_PER_MINUTE } : {}),
        };
    }

    let result: AgentRunResult;
    try {
        await deps.driver.ensureSession(key, cwd, acpCommand);
        try {
            result = await deps.driver.run(buildRunOptions(task), (evt) => {
                log(`acpx: ${JSON.stringify(evt)}`);
            });
        } finally {
            if (poller !== undefined) {
                poller.stop();
                await poller.settled;
            }
        }
    } finally {
        // Restore the cwd's `.acpxrc.json` regardless of how the run ended (success,
        // Throw, timeout, or cooperative cancel). For a throwaway worktree this is
        // Harmless; for an in-place repo (rare on --auto) it keeps it clean.
        mcpCleanup?.();
    }

    // HARD TIMEOUT: the driver killed a hung run past its wall-clock deadline and the
    // Agent never emitted a report. Synthesize a `failed` report so the rest of the
    // Function routes it through the SAME writeback path (yield check → applyReport →
    // Terminal save → escalation) — a real failed report and a timeout park identically.
    // An agent that DID emit a report before the kill keeps its own report (honored).
    if (result.timedOut && result.report === null) {
        log(`beflow: ${key} timed out after ${String(maxRunMinutes)} minutes; stopped and parking as failed`);
        result = {
            ...result,
            report: {
                status: "failed",
                summary: `Agent run timed out after ${String(maxRunMinutes)} minutes and was stopped automatically.`,
            },
        };
    } else if (result.report === null && (result.exitCode !== 0 || result.stream.error !== undefined)) {
        // CRASH: the agent process exited non-zero or the ACP stream carried an error,
        // Yet emitted no report (and did not time out). Synthesize a `failed` report so
        // The run routes through the SAME writeback path as the timeout park above — a
        // Crash and a timeout fail identically, never silently left In Progress.
        const cause =
            result.stream.error !== undefined
                ? `stream error: ${result.stream.error.message}`
                : `exit code ${String(result.exitCode)}`;
        log(`beflow: ${key} crashed (${cause}); stopped and parking as failed`);
        result = {
            ...result,
            report: {
                status: "failed",
                summary: `Agent run crashed (${cause}) and produced no report.`,
            },
        };
    }

    // YIELD: the human is authoritative for STATE. If the card was moved out of the
    // Started group while the agent worked, skip writeback so beflow doesn't fight
    // The human — but preserve the agent's work as a comment and clean up.
    const git = deps.git;
    const yielded = await yieldToManualMove({
        cleanup:
            (worktreeCreated || isResume) && git !== undefined
                ? async (): Promise<void> => {
                      await removeWorktree(effectiveRepoPath, cwd, git);
                  }
                : undefined,
        issue,
        key,
        log,
        report: result.report,
        runsDir,
        runsFs: deps.runsFs,
        tracker: deps.tracker,
    });
    if (yielded) {
        return { applied: undefined, cwd, issue, resolved, result };
    }

    // TELEMETRY (opt-in): a compact token/cost line for the writeback comment,
    // Built only when the project opts in AND the agent reported usage. Undefined
    // Otherwise so applyReport appends nothing. Cost is included only when the
    // Usage_update event itself carried one (no pricing table is invented here).
    const telemetryEnabled = resolveTelemetryInComment(deps.config, deps.registry, projectKeyOf(key));
    const telemetryModel = deps.config.agents[effectiveAgent]?.model;
    function telemetryLine(): string | undefined {
        if (!telemetryEnabled || result.stream.usage === undefined) {
            return undefined;
        }
        return formatTelemetryLine(result.stream.usage, telemetryModel, record.attempts);
    }

    // Park the run as FAILED while KEEPING the worktree (and any draft PR): writes the
    // Failed report back, persists a failed record, and escalates. Used by the
    // Beflow-owned PR paths (no-op, gh/policy-layer failure) which are all retryable.
    async function parkBeflowFailed(summary: string): Promise<RunResult> {
        const failedReport: Report = { status: "failed", summary };
        const failedApplied = await applyReport(deps.tracker, issue, failedReport, effectiveJobKind, telemetryLine());
        saveRecord(
            runsDir,
            {
                ...record,
                attempts: 0,
                report: failedReport,
                status: "failed",
                updatedAt: clock(),
                ...(result.stream.usage !== undefined ? { usage: result.stream.usage } : {}),
            },
            deps.runsFs,
        );
        await notifyEscalation(deps.notify, issue, "failed", escalationDetail(failedReport));
        return { applied: failedApplied, cwd, issue, resolved, result };
    }

    // BEFLOW-OWNED PR — STEP 1+2 (before the gate): the agent reported `done` and only
    // Pushed its branch. First confirm it produced commits; if not, the run is empty —
    // Park failed and keep the worktree (no PR). Otherwise open a DRAFT PR from the
    // Pushed branch and stamp its URL onto the report so the writeback path links it.
    // The draft is enriched + marked ready (or closed) by the post-gate policy step.
    const prExec = deps.prExec ?? bunExec;
    let openedPr: PrRef | undefined;
    let beflowBase = "";
    if (beflowOwned && branch !== undefined && result.report?.status === "done") {
        try {
            beflowBase = await detectBaseBranch(resolved.repo, resolvedPr.baseBranch, prExec);
            if (!(await hasCommits(cwd, beflowBase, prExec))) {
                log(`beflow: ${key} — agent produced no commits; parking as failed (worktree kept)`);
                return await parkBeflowFailed(
                    "The agent reported done but produced no commits on its branch; nothing to open a PR from.",
                );
            }
            openedPr = await openDraftPr(
                {
                    base: beflowBase,
                    body: beflowPrBody(issue),
                    cwd,
                    head: branch,
                    repo: resolved.repo,
                    title: beflowPrTitle(issue),
                },
                prExec,
            );
            result = { ...result, report: { ...result.report, prUrl: openedPr.url } };
            log(`beflow: ${key} — opened draft PR ${openedPr.url}`);
        } catch (err) {
            log(
                `beflow: ${key} — PR layer failed (${err instanceof Error ? err.message : String(err)}); parking as failed (worktree kept)`,
            );
            return await parkBeflowFailed(
                `beflow could not open the pull request: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // QUALITY GATE (opt-in, autonomous-only): before an implement `done` report is
    // Allowed to open a PR / advance to In Review, run the project check command(s) in
    // The worktree. On RED, re-prompt the SAME live agent session up to `maxRework`
    // Times (default 1; 0 disables auto-rework) with the failing output, re-checking
    // After each. Still red (or a rework didn't re-emit `done`) → treat as failed.
    const gateCommands = resolveQualityGate(deps.config, deps.registry, projectKeyOf(key));
    const maxRework = resolveMaxRework(deps.config, deps.registry, projectKeyOf(key));
    if (effectiveJobKind === "implement" && result.report?.status === "done" && gateCommands.length > 0) {
        const gateExec = deps.gateExec ?? defaultGateExec;

        // BASELINE PINNING (opt-in, beflow-owned only): pin the gate's definition-of-
        // Passing to the TARGET branch. Before each gate run, restore the changed test
        // Files matching `baselineTestGlobs` from the base branch; run the gate against
        // The run's implementation + those baseline tests; then restore the worktree's
        // Own files. An agent can no longer self-grade by weakening a test it just edited.
        const baselineGlobs = resolveBaselineTestGlobs(deps.config, deps.registry, projectKeyOf(key));
        const pinBaseline = beflowOwned && baselineGlobs.length > 0;

        // Run the gate; a runner that THROWS fails OPEN (returns undefined): the gate is
        // An enhancement, not a correctness oracle, so an unrunnable gate proceeds as done.
        async function runGate(phase: string): Promise<{ output: string; passed: boolean } | undefined> {
            try {
                if (!pinBaseline) {
                    return await runQualityGate(gateCommands, cwd, gateExec);
                }
                const changedFiles = await computeChangedFiles(cwd, beflowBase, prExec);
                const restore = await pinBaselineTests(cwd, beflowBase, changedFiles, baselineGlobs, prExec);
                try {
                    return await runQualityGate(gateCommands, cwd, gateExec);
                } finally {
                    await restore();
                }
            } catch (err) {
                log(
                    `beflow: ${key} quality gate could not run${phase}: ${err instanceof Error ? err.message : String(err)}; proceeding as done`,
                );
                return undefined;
            }
        }

        // Park the run as FAILED after the gate exhausted its reworks (or rework was
        // Disabled). Increments the unified attempt counter (not reset) so repeated gate
        // Failures across dispatches accumulate toward the quarantine threshold.
        async function parkGateFailed(failingOutput: string, lastResult: AgentRunResult): Promise<RunResult> {
            const reworked = maxRework > 0;
            const failedReport: Report = {
                status: "failed",
                summary: `Quality gate failed${reworked ? " after auto-rework" : ""}:\n${failingOutput}`,
            };
            const failedUsage = lastResult.stream.usage;
            const failedTelemetry =
                telemetryEnabled && failedUsage !== undefined
                    ? formatTelemetryLine(failedUsage, telemetryModel, record.attempts)
                    : undefined;
            const failedApplied = await applyReport(
                deps.tracker,
                issue,
                failedReport,
                effectiveJobKind,
                failedTelemetry,
            );
            saveRecord(
                runsDir,
                {
                    ...record,
                    attempts: (record.attempts ?? 0) + 1,
                    report: failedReport,
                    status: "failed",
                    updatedAt: clock(),
                    ...(failedUsage !== undefined ? { usage: failedUsage } : {}),
                },
                deps.runsFs,
            );
            await notifyEscalation(deps.notify, issue, "failed", escalationDetail(failedReport));
            log(
                reworked
                    ? `beflow: ${key} quality gate still failing after auto-rework; parked as failed`
                    : `beflow: ${key} quality gate failed; parked as failed`,
            );
            return { applied: failedApplied, cwd, issue, resolved, result: lastResult };
        }

        const gate = await runGate("");
        if (gate !== undefined && !gate.passed) {
            if (maxRework === 0) {
                // Auto-rework disabled — park immediately on the first RED.
                return await parkGateFailed(gate.output, result);
            }
            // The gate RAN and returned RED — auto-rework against the same session up to
            // `maxRework` times, injecting the latest failing output as a continuation and
            // Re-checking after each attempt. The latest failing output is preferred when
            // The run finally gives up, falling back to the original gate output.
            let failingOutput = gate.output;
            let lastResult = result;
            let adopted = false;
            for (let attempt = 1; attempt <= maxRework; attempt += 1) {
                log(
                    `beflow: ${key} quality gate failed; auto-reworking (attempt ${String(attempt)}/${String(maxRework)})`,
                );
                const gateComment: Comment = {
                    body: `The quality gate failed. Fix these and re-emit the report block:\n${failingOutput}`,
                    createdAt: clock(),
                    id: "quality-gate",
                    isBot: false,
                };
                const reworkTask = renderContinuation(
                    deps.prompts,
                    {
                        newComments: [gateComment],
                        ...(lastResult.report?.prUrl !== undefined ? { prUrl: lastResult.report.prUrl } : {}),
                        ...(lastResult.report !== null ? { priorReport: lastResult.report } : {}),
                    },
                    beflowOwned,
                );
                const reworked = await deps.driver.run(buildRunOptions(reworkTask), (evt) => {
                    log(`acpx: ${JSON.stringify(evt)}`);
                });
                lastResult = reworked;
                // The rework re-prompt can take minutes; re-assert the human-authoritative
                // Yield check (as after the initial dispatch) so a card pulled out of the
                // Started group during rework is not clobbered by applyReport below.
                const reworkYielded = await yieldToManualMove({
                    cleanup:
                        (worktreeCreated || isResume) && git !== undefined
                            ? async (): Promise<void> => {
                                  await removeWorktree(effectiveRepoPath, cwd, git);
                              }
                            : undefined,
                    issue,
                    key,
                    log,
                    report: reworked.report,
                    runsDir,
                    runsFs: deps.runsFs,
                    tracker: deps.tracker,
                });
                if (reworkYielded) {
                    return { applied: undefined, cwd, issue, resolved, result: reworked };
                }
                const reworkedReport = reworked.report;
                const reworkGate = reworkedReport?.status === "done" ? await runGate(" on rework") : undefined;
                if (reworkedReport?.status === "done" && (reworkGate === undefined || reworkGate.passed)) {
                    // Rework produced a fresh `done` report AND the gate is green (or the
                    // Re-run threw → fail open) — adopt the new report and fall through. In
                    // Beflow-owned mode the agent never sets prUrl, so re-stamp the already
                    // Opened draft PR so the policy + writeback steps still link it.
                    result =
                        openedPr !== undefined
                            ? { ...reworked, report: { ...reworkedReport, prUrl: openedPr.url } }
                            : reworked;
                    adopted = true;
                    break;
                }
                if (reworkGate !== undefined && !reworkGate.passed) {
                    failingOutput = reworkGate.output;
                }
            }
            if (!adopted) {
                // Still red, or no rework re-emitted a `done` report, after the last
                // Allowed attempt → FAILED.
                return await parkGateFailed(failingOutput, lastResult);
            }
        }
    }

    // BEFLOW-OWNED PR — STEP 4 (after a green gate): evaluate the post-run policy over
    // The run's diff and decide the draft PR's fate. `block` closes the PR (keeping the
    // Branch for review/forensics) and routes the issue to the blocked/Needs-Input path
    // (NOT In Review); `require_approval`
    // Enriches the body but leaves the PR draft as the review artifact; `allow` enriches
    // And marks it ready. Any thrown PR/policy-layer error parks the run as failed while
    // Keeping the worktree + draft PR (retryable). Decided here so the shared writeback
    // Below still moves an allowed/approval run to In Review with the PR linked.
    let awaitsApproval = false;
    if (beflowOwned && openedPr !== undefined && branch !== undefined && result.report?.status === "done") {
        const policyExec = deps.policyExec ?? defaultPolicyExec;
        let decision: PolicyResult;
        let decisionFiles: string[];
        try {
            decisionFiles = await computeChangedFiles(cwd, beflowBase, prExec);
            decision = await evaluatePolicy(
                {
                    agent: effectiveAgent,
                    baseBranch: beflowBase,
                    changedFiles: decisionFiles,
                    issueKey: key,
                    jobKind: effectiveJobKind,
                    repo: resolved.repo,
                    ...(result.report.receipt !== undefined ? { receipt: result.report.receipt } : {}),
                },
                resolvedPolicy,
                policyExec,
                cwd,
                deps.policyReader ?? defaultPolicyReader,
            );
        } catch (err) {
            log(
                `beflow: ${key} — policy layer failed (${err instanceof Error ? err.message : String(err)}); parking as failed (worktree + draft PR kept)`,
            );
            return await parkBeflowFailed(
                `beflow could not evaluate the post-run policy: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        // Write the canonical, append-only decision event BEFORE any writeback (and,
        // Critically, before the allow path's deleteRecord can run): the tracker
        // Comment is ephemeral, the run record is GC'd, but this log survives both.
        const receiptTemplate = loadDecisionReceiptPrompt(deps.promptResolveDeps ?? COMPILED_ONLY_RESOLVE_DEPS);
        const sink =
            deps.decisionSink ??
            buildDefaultDecisionSink(deps.config, deps.tracker, issue, deps.runsFs, receiptTemplate, log);
        await sink.emit(
            buildDecisionEvent(
                {
                    changedFiles: decisionFiles,
                    decision: decision.decision,
                    evaluator: resolvedPolicy.evaluator,
                    key,
                    matchedRules: decision.matchedRules,
                    prUrl: openedPr.url,
                    reason: decision.reason,
                    runId: `${key}@${record.updatedAt}`,
                    ...(result.report.receipt !== undefined ? { receipt: result.report.receipt } : {}),
                },
                clock,
            ),
        );

        if (decision.decision === "block") {
            try {
                await closePr(openedPr, resolved.repo, prExec);
            } catch (err) {
                log(
                    `beflow: ${key} — closing the blocked PR failed (${err instanceof Error ? err.message : String(err)}); parking as failed`,
                );
                return await parkBeflowFailed(
                    `beflow could not close the policy-blocked pull request: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
            const blockedReport: Report = {
                status: "blocked",
                summary: `Policy blocked this change: ${decision.reason}`,
            };
            const blockedApplied = await applyReport(
                deps.tracker,
                issue,
                blockedReport,
                effectiveJobKind,
                telemetryLine(),
            );
            saveRecord(
                runsDir,
                {
                    ...record,
                    attempts: 0,
                    report: blockedReport,
                    status: "blocked",
                    updatedAt: clock(),
                    ...(result.stream.usage !== undefined ? { usage: result.stream.usage } : {}),
                },
                deps.runsFs,
            );
            await notifyEscalation(deps.notify, issue, "blocked", escalationDetail(blockedReport));
            log(`beflow: ${key} — policy blocked; closed PR (branch kept) and routed to Needs Input`);
            return { applied: blockedApplied, cwd, issue, resolved, result };
        }

        try {
            await editPr(openedPr, resolved.repo, { body: beflowPrBody(issue, result.report.summary) }, prExec);
            if (decision.decision === "allow") {
                await markReady(openedPr, resolved.repo, prExec);
            } else {
                awaitsApproval = true;
            }
        } catch (err) {
            log(
                `beflow: ${key} — finalizing the PR failed (${err instanceof Error ? err.message : String(err)}); parking as failed (worktree + draft PR kept)`,
            );
            return await parkBeflowFailed(
                `beflow could not finalize the pull request: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    let applied: WritebackResult | undefined;
    if (result.report !== null) {
        applied = await applyReport(deps.tracker, issue, result.report, effectiveJobKind, telemetryLine());
    } else {
        log(`beflow: ${key} produced no report; left In Progress`);
    }

    const reportStatus = result.report?.status;
    if (reportStatus === "done") {
        if (effectiveJobKind === "implement") {
            // Implement done → In Review: keep the worktree + record (with the PR and
            // report) so a changes-requested rework can resume in place. Cleanup happens
            // at Done (PR merged), handled by watch.
            saveRecord(
                runsDir,
                {
                    ...record,
                    attempts: 0,
                    status: "done",
                    updatedAt: clock(),
                    ...(result.report !== null ? { report: result.report } : {}),
                    ...(result.report?.prUrl !== undefined ? { prUrl: result.report.prUrl } : {}),
                    ...(result.stream.usage !== undefined ? { usage: result.stream.usage } : {}),
                },
                deps.runsFs,
            );
            await postInReviewInstructionOnce(deps.tracker, issue, log);
            if (awaitsApproval) {
                const approvalNote = `This change requires human approval before merge: the draft pull request is the review artifact. Approve it to mark it ready and merge.`;
                await deps.tracker.comment(issue, approvalNote);
                await notifyEscalation(deps.notify, issue, "needs_input", approvalNote);
                log(`beflow: ${key} — policy requires approval; draft PR left for human review`);
            }
        } else {
            if (worktreeCreated || isResume) {
                if (git !== undefined) {
                    await removeWorktree(effectiveRepoPath, cwd, git);
                    log(`beflow: removed worktree at ${cwd}`);
                }
            }
            deleteRecord(runsDir, key, deps.runsFs);
        }
    } else if (reportStatus !== undefined) {
        saveRecord(
            runsDir,
            {
                ...record,
                attempts: 0,
                status: reportStatus,
                updatedAt: clock(),
                ...(result.report !== null ? { report: result.report } : {}),
                ...(result.report?.prUrl !== undefined ? { prUrl: result.report.prUrl } : {}),
                ...(result.stream.usage !== undefined ? { usage: result.stream.usage } : {}),
            },
            deps.runsFs,
        );
    }

    if (
        (reportStatus === "needs_input" || reportStatus === "blocked" || reportStatus === "failed") &&
        result.report !== null
    ) {
        await notifyEscalation(deps.notify, issue, reportStatus, escalationDetail(result.report));
    }

    return { applied, cwd, issue, resolved, result };
}

export interface InteractiveLaunch {
    agent: string;
    sessionKey: string;
    cwd: string;
    contract: string;
    task: string;
    acpCommand: string;
    acpxCommand: string[];
}

export type LaunchInteractive = (launch: InteractiveLaunch) => Promise<void>;

export interface OutcomeAnswer {
    status: Report["status"];
    prUrl?: string;
}

export interface OutcomeContext {
    jobKind: JobKind;
    key: string;
}

export type AskOutcome = (ctx: OutcomeContext) => Promise<OutcomeAnswer>;

export interface RunSupervisedDeps {
    tracker: Tracker;
    config: Config;
    registry: Registry;
    prompts: PromptSet;
    launchInteractive?: LaunchInteractive;
    askOutcome?: AskOutcome;
    ensureSession?: (sessionName: string, cwd: string, acpCommand: string) => Promise<void>;
    log?: Logger;
    notify?: Notifier;
    runsFs?: RunStoreFs;
    clock?: Clock;
    preResolved?: ResolvedRun;
    mcpServers?: McpServer[];
    mcpFs?: McpFs;
}

export interface SupervisedResult {
    issue: Issue;
    resolved: Resolved;
    cwd: string;
    report: Report;
    applied: WritebackResult;
}

export async function runSupervised(
    key: string,
    cli: Partial<Resolved>,
    deps: RunSupervisedDeps,
): Promise<SupervisedResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const launchInteractive = deps.launchInteractive ?? defaultLaunchInteractive;
    const askOutcome = deps.askOutcome ?? defaultAskOutcome;

    const { issue, resolved } =
        deps.preResolved ?? (await resolveRun(key, cli, deps.config, deps.registry, deps.tracker));

    const cwd = resolved.repoPath;
    const runsDir = resolveRunsDir(deps.config.runs?.dir);
    const clock = deps.clock ?? systemClock;

    await moveToInProgress(deps.tracker, issue);
    if (deps.config.assignee !== undefined) {
        await deps.tracker.assign(issue, deps.config.assignee);
    }

    const record: RunRecord = {
        agent: resolved.agent,
        cwd,
        jobKind: resolved.jobKind,
        key,
        repoPath: resolved.repoPath,
        runMode: resolved.runMode,
        sessionName: key,
        status: "in_progress",
        tracker: deps.config.tracker,
        updatedAt: clock(),
    };
    saveRecord(runsDir, record, deps.runsFs);

    const acpCommand = resolveAcpCommand(resolved.agent, deps.config.agents[resolved.agent]);

    if (deps.ensureSession !== undefined) {
        await deps.ensureSession(key, cwd, acpCommand);
    }

    const contract = renderContract(deps.prompts, resolved.jobKind, issue, resolved.repo);
    const task =
        renderTask(deps.prompts, issue, resolved.repo) +
        (await gatherLinkedContext(deps.tracker, issue, deps.config.linkedContext !== false, log));

    // Inject the managed `.acpxrc.json` into the repo checkout for the interactive
    // Acpx launch, then restore it in a finally so the user's repo is left exactly
    // As before (this is --attend, in-place: correctness of the restore matters most).
    const mcpCleanup =
        deps.mcpServers !== undefined && deps.mcpServers.length > 0
            ? injectAcpxMcp(cwd, deps.mcpServers, deps.mcpFs ?? nodeMcpFs)
            : undefined;
    try {
        await launchInteractive({
            acpCommand,
            acpxCommand: resolveAcpxCommand(deps.config),
            agent: resolved.agent,
            contract,
            cwd,
            sessionKey: key,
            task,
        });
    } finally {
        mcpCleanup?.();
    }

    const outcome = await askOutcome({ jobKind: resolved.jobKind, key });
    const report: Report = {
        status: outcome.status,
        summary: `Supervised run of ${key} ended with status "${outcome.status}".`,
        ...(outcome.prUrl !== undefined ? { prUrl: outcome.prUrl } : {}),
    };

    if (await yieldToManualMove({ issue, key, log, report, runsDir, runsFs: deps.runsFs, tracker: deps.tracker })) {
        return { applied: {}, cwd, issue, report, resolved };
    }

    const applied = await applyReport(deps.tracker, issue, report, resolved.jobKind);

    if (outcome.status === "done") {
        deleteRecord(runsDir, key, deps.runsFs);
    } else {
        saveRecord(
            runsDir,
            {
                ...record,
                status: outcome.status,
                updatedAt: clock(),
                report,
                ...(report.prUrl !== undefined ? { prUrl: report.prUrl } : {}),
            },
            deps.runsFs,
        );
    }

    if (outcome.status === "needs_input" || outcome.status === "blocked" || outcome.status === "failed") {
        await notifyEscalation(deps.notify, issue, outcome.status, report.summary);
    }

    log(`beflow: supervised ${key} → ${outcome.status}`);
    return { applied, cwd, issue, report, resolved };
}

export interface OpenLaunch {
    cwd: string;
    command: string;
    args: string[];
    task: string;
}

export type OpenIssue = (launch: OpenLaunch) => Promise<void>;

export interface RunOpenDeps {
    tracker: Tracker;
    config: Config;
    registry: Registry;
    prompts: PromptSet;
    openIssue?: OpenIssue;
    askOutcome?: AskOutcome;
    log?: Logger;
    notify?: Notifier;
    runsFs?: RunStoreFs;
    clock?: Clock;
    preResolved?: ResolvedRun;
}

// Launch the agent's NATIVE interactive TUI directly (no acpx). beflow shields
// Itself from the Ctrl+C meant for the agent: the signal still reaches the child
// (same foreground group), which handles it; beflow must survive so it can run
// The outcome prompt + writeback after the agent exits.
export async function defaultOpenIssue(launch: OpenLaunch): Promise<void> {
    function onSigint(): void {
        /* no-op: keep beflow alive while the child agent handles Ctrl+C */
    }
    process.on("SIGINT", onSigint);
    try {
        const proc = bun.spawn([launch.command, ...launch.args, launch.task], {
            cwd: launch.cwd,
            stdio: ["inherit", "inherit", "inherit"],
        });
        await proc.exited;
    } finally {
        process.removeListener("SIGINT", onSigint);
    }
}

export async function runOpen(key: string, cli: Partial<Resolved>, deps: RunOpenDeps): Promise<SupervisedResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const openIssue = deps.openIssue ?? defaultOpenIssue;
    const askOutcome = deps.askOutcome ?? defaultAskOutcome;

    const { issue, resolved } =
        deps.preResolved ?? (await resolveRun(key, cli, deps.config, deps.registry, deps.tracker));

    const agentCfg = deps.config.agents[resolved.agent];
    if (agentCfg === undefined) {
        throw new Error(`beflow: agent "${resolved.agent}" is not configured in config.agents`);
    }

    const cwd = resolved.repoPath;
    const runsDir = resolveRunsDir(deps.config.runs?.dir);
    const clock = deps.clock ?? systemClock;

    log(`beflow: ${key} resolved → agent ${resolved.agent}, jobKind ${resolved.jobKind}, repo ${resolved.repo}`);

    log(`beflow: moving ${key} to In Progress`);
    await moveToInProgress(deps.tracker, issue);
    if (deps.config.assignee !== undefined) {
        log(`beflow: assigning ${key} to ${deps.config.assignee}`);
        await deps.tracker.assign(issue, deps.config.assignee);
    }

    const record: RunRecord = {
        agent: resolved.agent,
        cwd,
        jobKind: resolved.jobKind,
        key,
        repoPath: resolved.repoPath,
        runMode: resolved.runMode,
        sessionName: key,
        status: "in_progress",
        tracker: deps.config.tracker,
        updatedAt: clock(),
    };
    saveRecord(runsDir, record, deps.runsFs);

    log(`beflow: launching ${agentCfg.command} in ${cwd}`);
    const task =
        renderTask(deps.prompts, issue, resolved.repo) +
        (await gatherLinkedContext(deps.tracker, issue, deps.config.linkedContext !== false, log)) +
        OPEN_SESSION_TRAILER;
    await openIssue({
        args: agentCfg.args ?? [],
        command: agentCfg.command,
        cwd,
        task,
    });

    const outcome = await askOutcome({ jobKind: resolved.jobKind, key });
    const report: Report = {
        status: outcome.status,
        summary: `Open run of ${key} ended with status "${outcome.status}".`,
        ...(outcome.prUrl !== undefined ? { prUrl: outcome.prUrl } : {}),
    };

    if (await yieldToManualMove({ issue, key, log, report, runsDir, runsFs: deps.runsFs, tracker: deps.tracker })) {
        return { applied: {}, cwd, issue, report, resolved };
    }

    const applied = await applyReport(deps.tracker, issue, report, resolved.jobKind);

    if (outcome.status === "done") {
        deleteRecord(runsDir, key, deps.runsFs);
    } else {
        saveRecord(
            runsDir,
            {
                ...record,
                status: outcome.status,
                updatedAt: clock(),
                report,
                ...(report.prUrl !== undefined ? { prUrl: report.prUrl } : {}),
            },
            deps.runsFs,
        );
    }

    if (outcome.status === "needs_input" || outcome.status === "blocked" || outcome.status === "failed") {
        await notifyEscalation(deps.notify, issue, outcome.status, report.summary);
    }

    log(`beflow: ${key} → ${outcome.status}${applied.movedTo !== undefined ? ` (${applied.movedTo})` : ""}`);
    return { applied, cwd, issue, report, resolved };
}

export function buildInteractiveArgs(launch: InteractiveLaunch): string[] {
    return [
        ...launch.acpxCommand,
        "--approve-reads",
        "--cwd",
        launch.cwd,
        "--append-system-prompt",
        launch.contract,
        "--agent",
        launch.acpCommand,
        "prompt",
        "-s",
        launch.sessionKey,
        launch.task,
    ];
}

async function defaultLaunchInteractive(launch: InteractiveLaunch): Promise<void> {
    const proc = bun.spawn(buildInteractiveArgs(launch), { stdio: ["inherit", "inherit", "inherit"] });
    await proc.exited;
}

async function defaultAskOutcome(ctx: OutcomeContext): Promise<OutcomeAnswer> {
    intro(`Outcome for ${ctx.key}`);

    const status = await select({
        message: `How did ${ctx.key} go?`,
        options: [
            { value: "done", label: "done", hint: `finished (→ ${defaultDoneState(ctx.jobKind)})` },
            { value: "needs_input", label: "needs_input", hint: "a human decision is required (→ Needs Input)" },
            { value: "blocked", label: "blocked", hint: "waiting on a dependency (+blocked label)" },
            { value: "failed", label: "failed", hint: "could not complete (stays put)" },
        ],
    });
    if (isCancel(status)) {
        cancel(`beflow: outcome cancelled — ${ctx.key} left In Progress (resume: beflow run ${ctx.key} --open)`);
        throw new Error(`beflow: outcome cancelled for ${ctx.key}`);
    }

    let prUrl: string | undefined;
    if (ctx.jobKind === "implement") {
        const answer = await text({
            message: "PR URL (blank for none)",
            placeholder: "https://…",
            defaultValue: "",
        });
        if (isCancel(answer)) {
            cancel(`beflow: outcome cancelled — ${ctx.key} left In Progress (resume: beflow run ${ctx.key} --open)`);
            throw new Error(`beflow: outcome cancelled for ${ctx.key}`);
        }
        const trimmed = answer.trim();
        if (trimmed !== "") {
            prUrl = trimmed;
        }
    }

    outro("Writing back…");
    return { status: status as ReportStatus, ...(prUrl !== undefined ? { prUrl } : {}) };
}
