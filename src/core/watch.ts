import type { AgentDriver } from "../agent/driver.ts";
import type { Config, Registry } from "../config/schema.ts";
import type { Issue, Resolved } from "../model/types.ts";
import { resolvePr } from "../resolve/precedence.ts";
import { IssueNotFoundError } from "../trackers/tracker.ts";
import type { Tracker } from "../trackers/tracker.ts";
import { assembleContinuation, renderContinuation } from "./continuation.ts";
import { QUARANTINED_LABEL, quarantine, resolveDeadLetterThreshold, shouldQuarantine } from "./deadletter.ts";
import { isDecisionHeld } from "./decision.ts";
import type { McpServer } from "./mcp.ts";
import { notifyEscalation } from "./notify.ts";
import type { Notifier } from "./notify.ts";
import type { PromptSet } from "./prompts.ts";
import { defaultPrComment, resolveReviewEnabled, resolveReviewPostToPr, runReview } from "./review.ts";
import type { PrCommenter, RunReviewDeps } from "./review.ts";
import { isPulledByHuman, runIssue } from "./run.ts";
import type { Logger, RunIssueDeps } from "./run.ts";
import { deleteRecord, listRecords, loadRecord, resolveRunsDir, saveRecord, systemClock } from "./runstore.ts";
import type { Clock, RunRecord, RunStoreFs } from "./runstore.ts";
import { ageMinutes, formatAge, resolveSla, shouldRemind } from "./sla.ts";
import { bunExec, removeWorktree } from "./worktree.ts";
import type { Exec } from "./worktree.ts";

const IN_PROGRESS_STATE = "In Progress";
const DONE_STATE = "Done";
const CHANGES_REQUESTED_LABEL = "changes-requested";
const BLOCKED_LABEL = "blocked";
const FAILED_LABEL = "failed";

const GUIDANCE_SENTINEL = "haven't described the changes";
const CHANGES_REQUESTED_GUIDANCE = `You added the \`${CHANGES_REQUESTED_LABEL}\` label but ${GUIDANCE_SENTINEL}. Please leave a comment explaining what to change, and beflow will pick it up automatically.`;

// watch is a headless drainer: it can only run autonomously (no human to supervise),
// so every dispatch forces autonomous mode regardless of the project's configured
// default runMode. This is what makes each run get an isolated worktree —
// useWorktree (run.ts) requires runMode "autonomous"; without it concurrent
// dispatches would share the repo working tree and corrupt each other's branches.
const AUTONOMOUS_DISPATCH: Partial<Resolved> = { runMode: "autonomous" };

// Safety floors used only when a project doesn't set its own limit.
const DEFAULT_LIMIT_IN_REVIEW = 5;
const DEFAULT_LIMIT_IN_PROGRESS = 3;

export interface PrCheckResult {
    failing: string[]; // names of failing checks (for the continuation detail)
    sha?: string; // PR head commit SHA (the loop-safety key)
    state: "failing" | "none" | "passing" | "pending";
}

export interface WatchDeps {
    tracker: Tracker;
    driver: AgentDriver;
    config: Config;
    registry: Registry;
    prompts: PromptSet;
    // When true, `watchTick` previews the dispatch decision and performs NO
    // Mutating pass, dispatch, or record write — a read-only single-tick plan.
    dryRun?: boolean;
    git?: Exec;
    log?: Logger;
    notify?: Notifier;
    runsFs?: RunStoreFs;
    clock?: Clock;
    fresh?: boolean;
    // When provided, each tick resolves the live config/registry from this
    // Snapshot so a hot-reloaded config takes effect on the next tick.
    getSnapshot?: () => { config: Config; registry: Registry };
    // When provided (and opted-in per project), the CI-red pass polls each
    // In-Review item's PR checks and re-dispatches rework on a red commit.
    // Omitted in tests that don't exercise that path; when undefined the pass
    // Is skipped (degrade safely), mirroring `prMerged`.
    prChecks?: (prUrl: string) => Promise<PrCheckResult>;
    // When provided, the auto-Done pass polls each In-Review item's linked PR and
    // Moves merged ones to Done. Omitted in tests that don't exercise that path;
    // When undefined the auto-Done pass is skipped (degrade safely).
    prMerged?: (prUrl: string) => Promise<boolean>;
    // Posts the reviewer agent's findings on the PR (only when review.postToPr is on).
    // Defaults to the gh-backed `defaultPrComment`; tests inject a spy.
    prCommenter?: PrCommenter;
    // The PR-review entrypoint, injected so tests can drive the review pass with a
    // Fake. Defaults to the real `runReview`. The review pass also requires `prChecks`
    // (its head-SHA source) and the per-project `review.enabled` opt-in.
    runReview?: (key: string, reviewDeps: RunReviewDeps) => Promise<unknown>;
    // ACP MCP servers (from the `.mcp.json` cascade) injected per dispatched run
    // Via acpx; threaded into each runIssueDeps build. Omitted when mcp is disabled.
    mcpServers?: McpServer[];
}

export async function defaultPrMerged(prUrl: string): Promise<boolean> {
    const res = await bunExec("gh", ["pr", "view", prUrl, "--json", "state", "--jq", ".state"]);
    return res.code === 0 && res.stdout.trim() === "MERGED";
}

const CI_FAILING_CONCLUSIONS = new Set(["CANCELLED", "ERROR", "FAILURE", "STARTUP_FAILURE", "TIMED_OUT"]);
const CI_FAILING_STATES = new Set(["ERROR", "FAILURE"]);
const CI_PENDING_STATUSES = new Set(["IN_PROGRESS", "PENDING", "QUEUED", "WAITING"]);

interface RollupEntry {
    __typename?: string;
    conclusion?: string;
    context?: string;
    name?: string;
    state?: string;
    status?: string;
}

export async function defaultPrChecks(prUrl: string): Promise<PrCheckResult> {
    const res = await bunExec("gh", ["pr", "view", prUrl, "--json", "statusCheckRollup,headRefOid"]);
    if (res.code !== 0) {
        return { failing: [], state: "none" };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(res.stdout);
    } catch {
        return { failing: [], state: "none" };
    }
    const obj: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    const rawRollup = obj.statusCheckRollup;
    const rollup: RollupEntry[] = Array.isArray(rawRollup)
        ? rawRollup.filter((e): e is RollupEntry => typeof e === "object" && e !== null)
        : [];
    const sha = typeof obj.headRefOid === "string" ? obj.headRefOid : undefined;
    const base: PrCheckResult = { failing: [], ...(sha !== undefined ? { sha } : {}), state: "none" };
    if (rollup.length === 0) {
        return base;
    }
    const failing: string[] = [];
    let pending = false;
    for (const entry of rollup) {
        const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toUpperCase() : undefined;
        const state = typeof entry.state === "string" ? entry.state.toUpperCase() : undefined;
        const status = typeof entry.status === "string" ? entry.status.toUpperCase() : undefined;
        if (
            (conclusion !== undefined && CI_FAILING_CONCLUSIONS.has(conclusion)) ||
            (state !== undefined && CI_FAILING_STATES.has(state))
        ) {
            failing.push(entry.name ?? entry.context ?? "(unknown check)");
            continue;
        }
        if ((status !== undefined && CI_PENDING_STATUSES.has(status)) || state === "PENDING") {
            pending = true;
        }
    }
    if (failing.length > 0) {
        return { ...base, failing, state: "failing" };
    }
    if (pending) {
        return { ...base, state: "pending" };
    }
    return { ...base, state: "passing" };
}

export type WatchAction =
    | "dispatched"
    | "parked"
    | "resumed"
    | "at-capacity"
    | "idle"
    | "error"
    | "completed"
    | "rework"
    | "ci-rework"
    | "answered"
    | "awaiting-feedback"
    | "orphaned"
    | "quarantined"
    | "reconciled"
    | "released"
    | "reviewed";

export interface WatchTickResult {
    action: WatchAction;
    key?: string;
}

function optionalDeps(deps: WatchDeps): { notify?: Notifier; runsFs?: RunStoreFs } {
    return {
        ...(deps.notify !== undefined ? { notify: deps.notify } : {}),
        ...(deps.runsFs !== undefined ? { runsFs: deps.runsFs } : {}),
    };
}

function runIssueDeps(deps: WatchDeps, config: Config, registry: Registry, log: Logger): RunIssueDeps {
    return {
        config,
        driver: deps.driver,
        git: deps.git,
        log,
        prompts: deps.prompts,
        registry,
        tracker: deps.tracker,
        ...(deps.runsFs !== undefined ? { runsFs: deps.runsFs } : {}),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        ...(deps.fresh !== undefined ? { fresh: deps.fresh } : {}),
        ...(deps.notify !== undefined ? { notify: deps.notify } : {}),
        ...(deps.mcpServers !== undefined ? { mcpServers: deps.mcpServers } : {}),
    };
}

function runReviewDeps(
    deps: WatchDeps,
    config: Config,
    registry: Registry,
    log: Logger,
    postToPr: boolean,
): RunReviewDeps {
    return {
        config,
        driver: deps.driver,
        log,
        postToPr,
        prCommenter: deps.prCommenter ?? defaultPrComment,
        prompts: deps.prompts,
        registry,
        tracker: deps.tracker,
        ...(deps.git !== undefined ? { git: deps.git } : {}),
        ...(deps.runsFs !== undefined ? { runsFs: deps.runsFs } : {}),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    };
}

export async function watchTick(projectKey: string, deps: WatchDeps): Promise<WatchTickResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const { config, registry } = deps.getSnapshot
        ? deps.getSnapshot()
        : { config: deps.config, registry: deps.registry };
    const runsDir = resolveRunsDir(config.runs?.dir);
    const clock = deps.clock ?? systemClock;
    const sla = resolveSla(config, registry, projectKey);
    const deadLetterThreshold = resolveDeadLetterThreshold(config, registry, projectKey);

    if (deps.dryRun === true) {
        return dryRunTick(projectKey, deps, config, registry, log);
    }

    // SLA re-escalation (opt-in housekeeping): a stuck item past its threshold gets a
    // Periodic `reminder` ping; once it had a reminder, a later `resolved` ping cancels
    // It. Writing `escalatedAt` must NOT bump `updatedAt`, else the age clock resets.
    async function remind(
        item: Issue,
        record: RunRecord | null,
        thresholdMin: number | undefined,
        state: string,
    ): Promise<void> {
        if (thresholdMin === undefined || record === null) {
            return;
        }
        if (!shouldRemind(clock(), record, thresholdMin)) {
            return;
        }
        const detail = `Stuck in ${state} for ${formatAge(ageMinutes(clock(), record.updatedAt))}.`;
        await notifyEscalation(deps.notify, item, "reminder", detail);
        saveRecord(runsDir, { ...record, escalatedAt: clock(), updatedAt: record.updatedAt }, deps.runsFs);
        log(`beflow: watch ${projectKey} — reminder ${item.key} (${state}, ${detail})`);
    }

    // (a) Crash-resume — driven by the RUN STORE, the source of truth for which runs
    // Should be live. Resume an interrupted autonomous run for THIS project before
    // Anything new, so a crashed/restarted process picks up where it left off. One
    // Unit per tick. Supervised runs are user-driven and never auto-resumed.
    const active = listRecords(runsDir, deps.runsFs).filter(
        (r) => r.status === "in_progress" && r.runMode === "autonomous" && r.key.startsWith(`${projectKey}-`),
    );
    for (const rec of active) {
        // Reconcile a manual pull: if a human moved the card out of the started
        // Group while the run was crashed/parked, don't resume — the human wins.
        let issue: Issue;
        try {
            issue = await deps.tracker.getIssue(rec.key);
        } catch (err) {
            if (err instanceof IssueNotFoundError) {
                // Gone (deleted). PARK: stop retrying, but LEAVE the worktree — it may hold
                // unpushed work and there's no issue left to comment it back to.
                deleteRecord(runsDir, rec.key, deps.runsFs);
                log(
                    `beflow: watch ${projectKey} — ${rec.key} gone (deleted); record dropped, worktree left at ${rec.cwd} for manual cleanup`,
                );
                return { action: "orphaned", key: rec.key };
            }
            throw err; // transient → bubble to the per-tick guard; record is KEPT, retried next tick
        }
        if (issue.archived === true) {
            // Archived. Same conservative park: stop acting on it, leave the worktree.
            deleteRecord(runsDir, rec.key, deps.runsFs);
            log(
                `beflow: watch ${projectKey} — ${rec.key} archived; record dropped, worktree left at ${rec.cwd} for manual cleanup`,
            );
            return { action: "orphaned", key: rec.key };
        }
        if (isPulledByHuman(issue)) {
            if (deps.git !== undefined && rec.cwd) {
                try {
                    await removeWorktree(rec.repoPath ?? rec.cwd, rec.cwd, deps.git);
                } catch {
                    // Best-effort: a stale or already-removed worktree must not block reconcile.
                }
            }
            deleteRecord(runsDir, rec.key, deps.runsFs);
            log(
                `beflow: watch ${projectKey} — ${rec.key} reconciled (now ${issue.state.name}); manual move, not resumed`,
            );
            return { action: "reconciled", key: rec.key };
        }
        if (shouldQuarantine(rec.attempts ?? 0, deadLetterThreshold)) {
            // Crash-loop dead-letter: quarantine for a human, stop auto-resuming. The
            // Universal counter accumulates failures across resume + CI-rework alike.
            await quarantine(
                issue,
                `Quarantined after ${String(rec.attempts ?? 0)} failed attempts — the run kept crashing or could not finish.`,
                { clock, record: rec, runsDir, tracker: deps.tracker, ...optionalDeps(deps) },
            );
            log(
                `beflow: watch ${projectKey} — ${rec.key} quarantined after ${String(rec.attempts ?? 0)} failed attempts → Needs Input`,
            );
            return { action: "quarantined", key: rec.key };
        }
        try {
            await runIssue(rec.key, AUTONOMOUS_DISPATCH, runIssueDeps(deps, config, registry, log));
            log(`beflow: watch ${projectKey} — resumed ${rec.key}`);
            return { action: "resumed", key: rec.key };
        } catch (err) {
            log(
                `beflow: watch ${projectKey} — resume ${rec.key} errored: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { action: "error", key: rec.key };
        }
    }

    // The cap check (pass d) still needs the board's In Progress count.
    const inProgress = await deps.tracker.listQueue({
        project: projectKey,
        state: IN_PROGRESS_STATE,
    });

    // (b) Housekeeping pre-pass over In Review (no early return; cheap, no agent).
    // Auto-Done: a merged linked PR moves the item to Done and cleans up.
    let inReview = await deps.tracker.listQueue({
        project: projectKey,
        state: "In Review",
    });
    let didComplete = false;
    const completedKeys = new Set<string>();
    if (deps.prMerged !== undefined) {
        for (const item of inReview) {
            const record = loadRecord(runsDir, item.key, deps.runsFs);
            if (record?.prUrl === undefined) {
                continue;
            }
            if (!(await deps.prMerged(record.prUrl))) {
                continue;
            }
            // Re-read fresh right before the promote: a human may have moved the card
            // Out of In Review in the window since the tick-top snapshot. beflow is done
            // With it either way (the PR is merged), so still clean up, but never
            // Override the human's chosen state.
            const fresh = await deps.tracker.getIssue(item.key);
            const stillInReview = fresh.state.name === "In Review";
            if (stillInReview) {
                await deps.tracker.updateState(item, DONE_STATE);
                if (record.escalatedAt !== undefined) {
                    await notifyEscalation(deps.notify, item, "resolved", "Merged and closed.");
                }
            }
            if (deps.git !== undefined && record.cwd) {
                try {
                    await removeWorktree(record.repoPath ?? record.cwd, record.cwd, deps.git);
                } catch {
                    // Best-effort: a stale or already-removed worktree must not block Done.
                }
            }
            deleteRecord(runsDir, item.key, deps.runsFs);
            if (stillInReview) {
                log(`beflow: watch ${projectKey} — ${item.key} merged → Done`);
                didComplete = true;
                completedKeys.add(item.key);
            } else {
                log(
                    `beflow: watch ${projectKey} — ${item.key} merged but card now ${fresh.state.name}; not promoting, handed off`,
                );
                completedKeys.add(item.key);
            }
        }
        if (completedKeys.size > 0) {
            inReview = inReview.filter((i) => !completedKeys.has(i.key));
        }
    }

    // SLA reminders over the surviving In-Review items (after auto-Done filtering).
    for (const item of inReview) {
        await remind(item, loadRecord(runsDir, item.key, deps.runsFs), sla.inReviewMinutes, "In Review");
    }

    // (c) Dispatch decision (ONE agent unit; order rework → answered → todo).
    // The rework/answered re-dispatches finish existing work (like crash-resume)
    // And are NOT gated by the Todo cap.
    let didGuide = false;
    for (const item of inReview) {
        if (!item.labels.includes(CHANGES_REQUESTED_LABEL)) {
            continue;
        }
        const record = loadRecord(runsDir, item.key, deps.runsFs);
        const ctx = await assembleContinuation(deps.tracker, item, {
            ...(record?.updatedAt !== undefined ? { since: record.updatedAt } : {}),
            record,
        });
        if (ctx.newComments.length > 0) {
            await deps.tracker.removeProperty(item, CHANGES_REQUESTED_LABEL);
            const beflowOwnsPr =
                record?.jobKind === "implement" && resolvePr(config, registry, projectKey).owner === "beflow";
            await runIssue(item.key, AUTONOMOUS_DISPATCH, {
                ...runIssueDeps(deps, config, registry, log),
                continuation: renderContinuation(deps.prompts, ctx, beflowOwnsPr),
            });
            log(`beflow: watch ${projectKey} — rework ${item.key}`);
            return { action: "rework", key: item.key };
        }
        // Label only, no description: post guidance once (idempotent), keep scanning.
        const comments = await deps.tracker.listComments(item);
        const last = comments.at(-1);
        if (!(last?.isBot === true && last.body.includes(GUIDANCE_SENTINEL))) {
            await deps.tracker.comment(item, CHANGES_REQUESTED_GUIDANCE);
            log(`beflow: watch ${projectKey} — ${item.key} changes-requested without description; posted guidance`);
            didGuide = true;
        }
    }

    // CI-red auto-rework (opt-in, gh-gated). A red CI check on an In-Review PR
    // Re-dispatches rework with the failure as continuation context, exactly like
    // A `changes-requested` label — but only after the explicit-human path above.
    // Loop-safe: never reworks the same head SHA twice; quarantines a perpetually
    // Red PR to Needs Input once the universal attempt counter hits the threshold.
    if (deps.prChecks !== undefined && registry.projects[projectKey]?.ci?.autoReworkOnRed === true) {
        for (const item of inReview) {
            const record = loadRecord(runsDir, item.key, deps.runsFs);
            if (record?.prUrl === undefined) {
                continue;
            }
            const checks = await deps.prChecks(record.prUrl);
            // Green again → clear the failure streak (housekeeping, no return).
            if (checks.state === "passing" && (record.attempts ?? 0) > 0) {
                saveRecord(runsDir, { ...record, attempts: 0 }, deps.runsFs);
                continue;
            }
            if (checks.state !== "failing") {
                continue;
            }
            // Loop-safety: never rework the same head SHA twice.
            if (checks.sha !== undefined && checks.sha === record.ciReworkSha) {
                continue;
            }

            const attempts = record.attempts ?? 0;
            if (shouldQuarantine(attempts, deadLetterThreshold)) {
                // Quarantine a PR CI can't get green: the universal counter accumulates
                // CI-rework failures together with crash-resume failures.
                await quarantine(
                    item,
                    `CI red after ${String(attempts)} auto-rework attempts: ${checks.failing.join(", ") || "(unknown)"}.`,
                    {
                        clock,
                        record: { ...record, ...(checks.sha !== undefined ? { ciReworkSha: checks.sha } : {}) },
                        runsDir,
                        tracker: deps.tracker,
                        ...optionalDeps(deps),
                    },
                );
                log(`beflow: watch ${projectKey} — ${item.key} CI-rework quarantined → Needs Input`);
                return { action: "quarantined", key: item.key };
            }

            const ctx = await assembleContinuation(deps.tracker, item, { record, since: record.updatedAt });
            const beflowOwnsPr =
                record.jobKind === "implement" && resolvePr(config, registry, projectKey).owner === "beflow";
            const failingChecks = checks.failing.join(", ") || "unknown checks";
            const ciNote = beflowOwnsPr
                ? `The CI checks on this PR are failing (${failingChecks}). Investigate the failures, fix them, and push your branch (beflow updates the PR). Then emit the report block.`
                : `The CI checks on this PR are failing (${failingChecks}). Investigate the failures, fix them, and update the existing PR (${record.prUrl}). Then emit the report block.`;
            const continuation = `${ciNote}\n\n${renderContinuation(deps.prompts, ctx, beflowOwnsPr)}`;
            await runIssue(item.key, AUTONOMOUS_DISPATCH, {
                ...runIssueDeps(deps, config, registry, log),
                continuation,
            });
            // RunIssue rewrites the record from scratch (resetting attempts to 0 on a
            // Continuation re-dispatch) — re-stamp the accumulated counter + loop-safety SHA.
            const after = loadRecord(runsDir, item.key, deps.runsFs);
            if (after !== null) {
                saveRecord(
                    runsDir,
                    {
                        ...after,
                        attempts: attempts + 1,
                        ...(checks.sha !== undefined ? { ciReworkSha: checks.sha } : {}),
                    },
                    deps.runsFs,
                );
            }
            log(
                `beflow: watch ${projectKey} — CI-rework ${item.key} (failing: ${checks.failing.join(", ") || "unknown"})`,
            );
            return { action: "ci-rework", key: item.key };
        }
    }

    // PR review assist (opt-in, gh-gated). When `review.enabled` and a head-SHA source
    // (`prChecks`) are both present, a reviewer agent reads each In-Review PR's diff and
    // Posts findings to the issue (and, when `postToPr`, to the PR). Loop-safe: never
    // Re-reviews the same head SHA. Reads-only on the board — never moves or merges.
    if (deps.prChecks !== undefined && resolveReviewEnabled(config, registry, projectKey)) {
        const postToPr = resolveReviewPostToPr(config, registry, projectKey);
        const review = deps.runReview ?? runReview;
        for (const item of inReview) {
            const record = loadRecord(runsDir, item.key, deps.runsFs);
            if (record?.prUrl === undefined) {
                continue;
            }
            const checks = await deps.prChecks(record.prUrl);
            if (checks.sha === undefined || checks.sha === record.reviewedSha) {
                continue;
            }
            const headSha = checks.sha;
            await review(item.key, {
                ...runReviewDeps(deps, config, registry, log, postToPr),
                reviewSha: async () => Promise.resolve(headSha),
            });
            log(`beflow: watch ${projectKey} — reviewed ${item.key}`);
            return { action: "reviewed", key: item.key };
        }
    }

    const needsInput = await deps.tracker.listQueue({
        project: projectKey,
        state: "Needs Input",
    });
    // SLA reminders BEFORE the answered loop so a reminder for a later item isn't
    // Skipped when the answered loop early-returns on the first re-activated item.
    for (const item of needsInput) {
        await remind(item, loadRecord(runsDir, item.key, deps.runsFs), sla.needsInputMinutes, "Needs Input");
    }
    // Decision-gate RELEASE pass: a decision-hold record whose issue NO LONGER carries
    // The `needs-decision` label means the human made the call; release it back to Todo.
    // Early-return on the first release, like the answered loop. The `heldReason` filter
    // Makes this pass act on (and only on) decision holds, never an unrelated Needs-Input.
    for (const item of needsInput) {
        const record = loadRecord(runsDir, item.key, deps.runsFs);
        if (record?.heldReason !== "decision") {
            continue;
        }
        if (isDecisionHeld(item.labels)) {
            continue; // decision still pending
        }
        // Re-read fresh right before the release: a human may have moved the card out
        // Of Needs Input in the window since the tick-top snapshot. If so, hand off
        // Cleanly — drop the hold record but never override the human's chosen state.
        const fresh = await deps.tracker.getIssue(item.key);
        if (fresh.state.name !== "Needs Input") {
            deleteRecord(runsDir, item.key, deps.runsFs);
            log(
                `beflow: watch ${projectKey} — ${item.key} decision made but card now ${fresh.state.name}; not releasing, handed off`,
            );
            continue;
        }
        await deps.tracker.updateState(item, "Todo");
        if (record.escalatedAt !== undefined) {
            await notifyEscalation(deps.notify, item, "resolved", "Decision made; released to Todo.");
        }
        deleteRecord(runsDir, item.key, deps.runsFs);
        log(`beflow: watch ${projectKey} — ${item.key} decision made (label removed) → released to Todo`);
        return { action: "released", key: item.key };
    }
    // Quarantine RELEASE pass: a quarantine-hold record whose issue NO LONGER carries the
    // `quarantined` label means a human cleared it for retry; reset the universal counter,
    // Clear the hold, and release it back to Todo. Mirrors the decision-release pass; the
    // `heldReason` filter scopes it to (and only to) quarantine holds.
    for (const item of needsInput) {
        const record = loadRecord(runsDir, item.key, deps.runsFs);
        if (record?.heldReason !== "quarantine") {
            continue;
        }
        if (item.labels.includes(QUARANTINED_LABEL)) {
            continue; // still quarantined
        }
        // Re-read fresh right before the release: a human may have moved the card out
        // Of Needs Input in the window since the tick-top snapshot. If so, hand off
        // Cleanly — drop the hold record but never override the human's chosen state.
        const fresh = await deps.tracker.getIssue(item.key);
        if (fresh.state.name !== "Needs Input") {
            deleteRecord(runsDir, item.key, deps.runsFs);
            log(
                `beflow: watch ${projectKey} — ${item.key} quarantine cleared but card now ${fresh.state.name}; not releasing, handed off`,
            );
            continue;
        }
        await deps.tracker.updateState(item, "Todo");
        if (record.escalatedAt !== undefined) {
            await notifyEscalation(deps.notify, item, "resolved", "Quarantine cleared; released to Todo.");
        }
        // `heldReason: undefined` clears the hold — JSON.stringify drops undefined keys.
        saveRecord(runsDir, { ...record, attempts: 0, heldReason: undefined, updatedAt: clock() }, deps.runsFs);
        log(`beflow: watch ${projectKey} — ${item.key} quarantine cleared (label removed) → released to Todo`);
        return { action: "released", key: item.key };
    }
    for (const item of needsInput) {
        // A still-`needs-decision`-labeled item is resolved by removing the label (the
        // Release pass above), NOT by commenting — so a comment can't bypass an undecided
        // Hold. Skip it here.
        if (isDecisionHeld(item.labels)) {
            continue;
        }
        const record = loadRecord(runsDir, item.key, deps.runsFs);
        const ctx = await assembleContinuation(deps.tracker, item, {
            ...(record?.updatedAt !== undefined ? { since: record.updatedAt } : {}),
            record,
        });
        if (ctx.newComments.length > 0) {
            // A human re-activated this item; clear the reason-tag that parked it.
            for (const label of [BLOCKED_LABEL, FAILED_LABEL]) {
                if (item.labels.includes(label)) {
                    await deps.tracker.removeProperty(item, label);
                }
            }
            if (record?.escalatedAt !== undefined) {
                await notifyEscalation(deps.notify, item, "resolved", "A human responded; resuming.");
            }
            const beflowOwnsPr =
                record?.jobKind === "implement" && resolvePr(config, registry, projectKey).owner === "beflow";
            await runIssue(item.key, AUTONOMOUS_DISPATCH, {
                ...runIssueDeps(deps, config, registry, log),
                continuation: renderContinuation(deps.prompts, ctx, beflowOwnsPr),
            });
            log(`beflow: watch ${projectKey} — answered ${item.key}`);
            return { action: "answered", key: item.key };
        }
    }

    // (d) Caps + Todo dispatch — unchanged.
    const limits = registry.projects[projectKey]?.limits;
    const inProgressCap = limits?.inProgress ?? DEFAULT_LIMIT_IN_PROGRESS;
    if (inProgress.length >= inProgressCap) {
        log(
            `beflow: watch ${projectKey} — In Progress at cap (${String(inProgress.length)}/${String(inProgressCap)}); skipping`,
        );
        return finalize(didComplete, didGuide, { action: "at-capacity" });
    }

    const inReviewCap = limits?.inReview ?? DEFAULT_LIMIT_IN_REVIEW;
    if (inReview.length >= inReviewCap) {
        log(
            `beflow: watch ${projectKey} — In Review at cap (${String(inReview.length)}/${String(inReviewCap)}); skipping`,
        );
        return finalize(didComplete, didGuide, { action: "at-capacity" });
    }

    let todo = await deps.tracker.listQueue({
        project: projectKey,
        state: "Todo",
    });
    if (registry.projects[projectKey]?.scheduling?.activeCycleOnly === true) {
        const cycleIds = await deps.tracker.activeCycleIssueIds(projectKey);
        if (cycleIds !== null) {
            const before = todo.length;
            todo = todo.filter((t) => cycleIds.has(t.id));
            log(
                `beflow: watch ${projectKey} — active-cycle filter: ${String(todo.length)}/${String(before)} Todo in cycle`,
            );
        } else {
            log(
                `beflow: watch ${projectKey} — activeCycleOnly set but no active cycle determinable; dispatching without cycle filter`,
            );
        }
    }
    if (todo.length === 0) {
        log(`beflow: watch ${projectKey} — Todo empty; idle`);
        return finalize(didComplete, didGuide, { action: "idle" });
    }

    // Respect blocked-by: walk the priority-ranked queue and COLLECT up to the
    // Remaining capacity worth of eligible Todos — those whose blockers are ALL
    // Resolved and that aren't quarantined (and, when the cycle filter is on, that
    // Survived it above). The at-capacity early-return guaranteed at least one open
    // Slot here. A relations-fetch failure bubbles to the per-tick guard rather than
    // Being mistaken for "unblocked".
    const slots = inProgressCap - inProgress.length;
    const selected: Issue[] = [];
    for (const candidate of todo) {
        if (selected.length >= slots) {
            break;
        }
        if (candidate.labels.includes(QUARANTINED_LABEL)) {
            log(`beflow: watch ${projectKey} — ${candidate.key} skipped: quarantined`);
            continue;
        }
        const pending = (await deps.tracker.blockedBy(candidate)).filter((b) => !b.done);
        if (pending.length === 0) {
            selected.push(candidate);
            continue;
        }
        log(
            `beflow: watch ${projectKey} — ${candidate.key} skipped: blocked-by ${pending
                .map((b) => b.key)
                .join(", ")} (not done)`,
        );
    }
    if (selected.length === 0) {
        log(`beflow: watch ${projectKey} — all Todo blocked; idle`);
        return finalize(didComplete, didGuide, { action: "idle" });
    }

    // Dispatch the collected batch CONCURRENTLY, bounded by the remaining cap so it
    // Can never be exceeded. Each runIssue does its own record-first claim, so
    // Distinct issues are safe to run in parallel. A throw or thin-park on one item
    // Must not abort the others — each outcome is captured per item.
    const outcomes = await Promise.all(
        selected.map(async (candidate): Promise<{ key: string; status: "dispatched" | "error" | "parked" }> => {
            try {
                const r = await runIssue(candidate.key, AUTONOMOUS_DISPATCH, runIssueDeps(deps, config, registry, log));
                if (r.parked === "thin") {
                    log(`beflow: watch ${projectKey} — ${candidate.key} parked: thin description → Needs Input`);
                    return { key: candidate.key, status: "parked" };
                }
                return { key: candidate.key, status: "dispatched" };
            } catch (err) {
                log(
                    `beflow: watch ${projectKey} — dispatch ${candidate.key} errored: ${err instanceof Error ? err.message : String(err)}`,
                );
                return { key: candidate.key, status: "error" };
            }
        }),
    );

    const firstDispatched = outcomes.find((o) => o.status === "dispatched");
    if (firstDispatched !== undefined) {
        const dispatched = outcomes.filter((o) => o.status === "dispatched");
        log(
            `beflow: watch ${projectKey} — dispatched ${String(dispatched.length)}: ${dispatched
                .map((o) => o.key)
                .join(", ")}`,
        );
        return { action: "dispatched", key: firstDispatched.key };
    }
    const firstParked = outcomes.find((o) => o.status === "parked");
    if (firstParked !== undefined) {
        return { action: "parked", key: firstParked.key };
    }
    // Every collected item errored — surface the first as the representative error.
    const firstErrored = outcomes.find((o) => o.status === "error");
    return { action: "error", key: firstErrored?.key };
}

// Read-only preview of one tick: fetch the cap counts + the Todo queue, apply the
// Same quarantine / blocked-by / active-cycle filters the live dispatch uses, and
// LOG the decision beflow WOULD make — never resuming, mutating the board, writing
// A record, or dispatching an agent. Mirrors the cap + eligibility logic in the
// Tail of `watchTick`, stopping short of every side effect.
async function dryRunTick(
    projectKey: string,
    deps: WatchDeps,
    config: Config,
    registry: Registry,
    log: Logger,
): Promise<WatchTickResult> {
    const inProgress = await deps.tracker.listQueue({ project: projectKey, state: IN_PROGRESS_STATE });
    const inReview = await deps.tracker.listQueue({ project: projectKey, state: "In Review" });

    const limits = registry.projects[projectKey]?.limits;
    const inProgressCap = limits?.inProgress ?? DEFAULT_LIMIT_IN_PROGRESS;
    if (inProgress.length >= inProgressCap) {
        log(
            `beflow: watch ${projectKey} — DRY RUN: In Progress at cap (${String(inProgress.length)}/${String(inProgressCap)}); would skip`,
        );
        return { action: "at-capacity" };
    }
    const inReviewCap = limits?.inReview ?? DEFAULT_LIMIT_IN_REVIEW;
    if (inReview.length >= inReviewCap) {
        log(
            `beflow: watch ${projectKey} — DRY RUN: In Review at cap (${String(inReview.length)}/${String(inReviewCap)}); would skip`,
        );
        return { action: "at-capacity" };
    }

    let todo = await deps.tracker.listQueue({ project: projectKey, state: "Todo" });
    if (registry.projects[projectKey]?.scheduling?.activeCycleOnly === true) {
        const cycleIds = await deps.tracker.activeCycleIssueIds(projectKey);
        if (cycleIds !== null) {
            todo = todo.filter((t) => cycleIds.has(t.id));
        }
    }
    if (todo.length === 0) {
        log(`beflow: watch ${projectKey} — DRY RUN: Todo empty; would idle`);
        return { action: "idle" };
    }

    const slots = inProgressCap - inProgress.length;
    const selected: Issue[] = [];
    for (const candidate of todo) {
        if (selected.length >= slots) {
            break;
        }
        if (candidate.labels.includes(QUARANTINED_LABEL)) {
            log(`beflow: watch ${projectKey} — DRY RUN: ${candidate.key} skipped: quarantined`);
            continue;
        }
        const pending = (await deps.tracker.blockedBy(candidate)).filter((b) => !b.done);
        if (pending.length === 0) {
            selected.push(candidate);
            continue;
        }
        log(
            `beflow: watch ${projectKey} — DRY RUN: ${candidate.key} skipped: blocked-by ${pending
                .map((b) => b.key)
                .join(", ")} (not done)`,
        );
    }
    if (selected.length === 0) {
        log(`beflow: watch ${projectKey} — DRY RUN: all Todo blocked; would idle`);
        return { action: "idle" };
    }

    const [first] = selected;
    log(`beflow: watch ${projectKey} — DRY RUN: would dispatch ${selected.map((c) => c.key).join(", ")}`);
    return { action: "dispatched", key: first?.key };
}

// (e) Final return when nothing was dispatched: surface housekeeping side-effects
// (auto-Done / guidance) ahead of the plain idle / at-capacity outcome.
function finalize(didComplete: boolean, didGuide: boolean, fallback: WatchTickResult): WatchTickResult {
    if (didComplete) {
        return { action: "completed" };
    }
    if (didGuide) {
        return { action: "awaiting-feedback" };
    }
    return fallback;
}

export interface WatchControl {
    sleepMs: number;
    sleep?: (ms: number) => Promise<void>;
    shouldStop: () => boolean;
}

async function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function watch(projectKey: string, deps: WatchDeps, ctrl: WatchControl): Promise<void> {
    const sleep = ctrl.sleep ?? defaultSleep;
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    while (!ctrl.shouldStop()) {
        try {
            await watchTick(projectKey, deps);
        } catch (err) {
            // One bad tick (a transient tracker failure, a thrown reconcile, etc.)
            // Must never kill the daemon — log it and continue to the next tick.
            log(`beflow: watch ${projectKey} — tick errored: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (ctrl.shouldStop()) {
            break;
        }
        await sleep(ctrl.sleepMs);
    }
}
