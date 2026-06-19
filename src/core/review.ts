import { existsSync } from "node:fs";

import { z } from "zod";

import { resolveAcpCommand } from "../agent/acpx.ts";
import type { AgentDriver } from "../agent/driver.ts";
import type { Config, Registry } from "../config/schema.ts";
import type { Tracker } from "../trackers/tracker.ts";
import type { PromptSet } from "./prompts.ts";
import { renderReviewContract } from "./prompts.ts";
import { resolveRun } from "./run.ts";
import type { Logger, ResolvedRun } from "./run.ts";
import { loadRecord, resolveRunsDir, saveRecord, systemClock } from "./runstore.ts";
import type { Clock, RunStoreFs } from "./runstore.ts";
import { bunExec, createWorktree, resolveWorktreeDir } from "./worktree.ts";
import type { Exec } from "./worktree.ts";

const IN_REVIEW_STATE = "In Review";
const SECONDS_PER_MINUTE = 60;

export const reviewFindingSchema = z.object({
    comment: z.string(),
    file: z.string().optional(),
    line: z.number().optional(),
    severity: z.enum(["blocker", "major", "minor", "nit"]),
});

export const reviewReportSchema = z.object({
    findings: z.array(reviewFindingSchema),
    summary: z.string(),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewReport = z.infer<typeof reviewReportSchema>;

// Mirrors `extractReport`: the LAST fenced block whose info string is exactly
// `beflow-review` (tolerating trailing whitespace + CRLF) is parsed and validated.
const blockPattern = /```beflow-review[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export function extractReviewReport(text: string): ReviewReport | null {
    let inner: string | null = null;
    for (const match of text.matchAll(blockPattern)) {
        inner = match[1] ?? null;
    }
    if (inner === null) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(inner);
    } catch {
        return null;
    }

    const result = reviewReportSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

// Posts a comment on the PR (never the issue). Injectable so tests can spy on it
// Without a real `gh`.
export type PrCommenter = (prUrl: string, body: string) => Promise<void>;

export async function defaultPrComment(prUrl: string, body: string): Promise<void> {
    await bunExec("gh", ["pr", "comment", prUrl, "--body", body]);
}

// Source of the PR head SHA, used to skip re-review of an unchanged head. Mirrors
// The `prChecks` seam in watch (whose result carries the head SHA).
export type ReviewSha = (prUrl: string) => Promise<string | undefined>;

// Project-over-default resolution of the per-project review toggles.
export function resolveReviewEnabled(config: Config, registry: Registry, projectKey: string): boolean {
    return registry.projects[projectKey]?.review?.enabled ?? config.review?.enabled ?? false;
}

export function resolveReviewPostToPr(config: Config, registry: Registry, projectKey: string): boolean {
    return registry.projects[projectKey]?.review?.postToPr ?? config.review?.postToPr ?? false;
}

function projectKeyOf(issueKey: string): string {
    const dash = issueKey.lastIndexOf("-");
    if (dash === -1) {
        throw new Error(`beflow: malformed issue key "${issueKey}"`);
    }
    return issueKey.slice(0, dash);
}

const SEVERITY_RANK: Record<ReviewFinding["severity"], number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

function formatReviewBody(report: ReviewReport): string {
    const lines = [`## Review\n`, report.summary];
    if (report.findings.length === 0) {
        lines.push("\nNo findings — the PR looks clean.");
        return lines.join("\n");
    }
    lines.push("\n### Findings");
    const ordered = [...report.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    for (const f of ordered) {
        const location =
            f.file !== undefined ? (f.line !== undefined ? `${f.file}:${String(f.line)}` : f.file) : undefined;
        const where = location !== undefined ? `${location} — ` : "";
        lines.push(`- [${f.severity}] ${where}${f.comment}`);
    }
    return lines.join("\n");
}

export interface ReviewResult {
    reviewed: boolean;
    findings?: number;
    reason?: string;
}

export interface RunReviewDeps {
    tracker: Tracker;
    driver: AgentDriver;
    config: Config;
    registry: Registry;
    prompts: PromptSet;
    git?: Exec;
    log?: Logger;
    runsFs?: RunStoreFs;
    clock?: Clock;
    pathExists?: (p: string) => boolean;
    preResolved?: ResolvedRun;
    prCommenter?: PrCommenter;
    reviewSha?: ReviewSha;
    postToPr?: boolean;
}

// Agent-driven PR review: a reviewer agent reads the PR diff and emits a structured
// `beflow-review` block. The findings are posted to the ISSUE always, and to the PR
// When opted in. NEVER changes board state, NEVER merges or pushes. Degrade-safe: any
// Precondition miss or gh/tracker error is logged and returns rather than throwing.
export async function runReview(key: string, deps: RunReviewDeps): Promise<ReviewResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const clock = deps.clock ?? systemClock;
    const pathExists = deps.pathExists ?? existsSync;

    let resolved: ResolvedRun;
    try {
        resolved = deps.preResolved ?? (await resolveRun(key, {}, deps.config, deps.registry, deps.tracker));
    } catch (err) {
        log(`beflow: review ${key} — could not resolve: ${err instanceof Error ? err.message : String(err)}`);
        return { reason: "resolve-failed", reviewed: false };
    }
    const { issue } = resolved;

    if (issue.state.name !== IN_REVIEW_STATE && issue.state.group !== "started") {
        log(`beflow: review ${key} — not In Review (${issue.state.name}); skipping`);
        return { reason: "not-in-review", reviewed: false };
    }

    const runsDir = resolveRunsDir(deps.config.runs?.dir);
    const record = loadRecord(runsDir, key, deps.runsFs);
    if (record?.prUrl === undefined) {
        log(`beflow: review ${key} — no PR on record; skipping`);
        return { reason: "no-pr", reviewed: false };
    }
    const { prUrl } = record;

    // Reuse the implement worktree when it survives; otherwise carve a fresh one off
    // The repo so the reviewer agent has the diff locally for `gh pr diff`.
    let cwd: string;
    let createdWorktree = false;
    if (record.cwd !== "" && pathExists(record.cwd)) {
        cwd = record.cwd;
    } else if (deps.git !== undefined) {
        const baseDir = resolveWorktreeDir(deps.config.worktrees?.dir);
        try {
            cwd = await createWorktree(record.repoPath ?? resolved.resolved.repoPath, key, deps.git, baseDir);
            createdWorktree = true;
        } catch (err) {
            log(
                `beflow: review ${key} — could not prepare a worktree: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { reason: "no-worktree", reviewed: false };
        }
    } else {
        cwd = resolved.resolved.repoPath;
    }
    if (createdWorktree) {
        log(`beflow: review ${key} — created worktree at ${cwd}`);
    }

    const sessionKey = `${key}:review`;
    const acpCommand = resolveAcpCommand(resolved.resolved.agent, deps.config.agents[resolved.resolved.agent]);
    const contract = renderReviewContract(deps.prompts, issue, resolved.resolved.repo);
    const maxRunMinutes = deps.registry.projects[projectKeyOf(key)]?.limits?.maxRunMinutes ?? 0;

    let assistantText: string;
    try {
        await deps.driver.ensureSession(sessionKey, cwd, acpCommand);
        const result = await deps.driver.run(
            {
                acpCommand,
                contract,
                cwd,
                nonInteractive: "fail",
                runMode: "autonomous",
                sessionKey,
                task: contract,
                ...(maxRunMinutes > 0 ? { timeoutSeconds: maxRunMinutes * SECONDS_PER_MINUTE } : {}),
            },
            (evt) => {
                log(`acpx: ${JSON.stringify(evt)}`);
            },
        );
        assistantText = result.stream.assistantText;
    } catch (err) {
        log(`beflow: review ${key} — agent dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        return { reason: "dispatch-failed", reviewed: false };
    }

    const report = extractReviewReport(assistantText);
    if (report === null) {
        log(`beflow: review ${key} — agent produced no review block; skipping`);
        return { reason: "no-report", reviewed: false };
    }

    const body = formatReviewBody(report);
    try {
        await deps.tracker.comment(issue, body);
    } catch (err) {
        log(`beflow: review ${key} — issue comment failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const postToPr = deps.postToPr ?? resolveReviewPostToPr(deps.config, deps.registry, projectKeyOf(key));
    if (postToPr) {
        const prCommenter = deps.prCommenter ?? defaultPrComment;
        try {
            await prCommenter(prUrl, body);
        } catch (err) {
            log(`beflow: review ${key} — PR comment failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Record the reviewed head so a later watch pass skips an unchanged PR. Obtain the
    // SHA from the injected source; fall back to keeping the prior value when unknown.
    let reviewedSha: string | undefined = record.reviewedSha;
    if (deps.reviewSha !== undefined) {
        try {
            reviewedSha = (await deps.reviewSha(prUrl)) ?? reviewedSha;
        } catch (err) {
            log(`beflow: review ${key} — head SHA lookup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    saveRecord(
        runsDir,
        {
            ...record,
            updatedAt: clock(),
            ...(reviewedSha !== undefined ? { reviewedSha } : {}),
        },
        deps.runsFs,
    );

    log(
        `beflow: review ${key} — posted ${String(report.findings.length)} finding(s)${postToPr ? " (issue + PR)" : ""}`,
    );
    return { findings: report.findings.length, reviewed: true };
}
