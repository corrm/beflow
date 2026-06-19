import { Glob, spawn } from "bun";

import type { PolicyDecision, ResolvedPolicy } from "../model/types.ts";
import type { Exec } from "./worktree.ts";

/** The change context handed to the policy gate after a run produces a diff. */
export interface PolicyContext {
    agent: string;
    jobKind: string;
    repo: string;
    baseBranch: string;
    changedFiles: string[];
    issueKey: string;
}

export interface PolicyResult {
    decision: PolicyDecision;
    reason: string;
}

/**
 * Injectable runner for the external command evaluator: spawns `argv` in `cwd`,
 * pipes `stdin` to it, and returns the exit code with stdout/stderr. Tests fake
 * this; production uses `defaultPolicyExec`.
 */
export type PolicyExec = (
    argv: string[],
    cwd: string,
    stdin: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Most-restrictive-wins ordering: a lower rank beats a higher one. */
const DECISION_RANK: Record<PolicyDecision, number> = { block: 0, require_approval: 1, allow: 2 };

/**
 * Changed files relative to the merge-base of `base` and HEAD. The three-dot form
 * isolates the run's own changes from commits that landed on `base` in parallel.
 */
export async function computeChangedFiles(cwd: string, base: string, exec: Exec): Promise<string[]> {
    const result = await exec("git", ["-C", cwd, "diff", "--name-only", `${base}...HEAD`]);
    if (result.code !== 0) {
        throw new Error(`beflow: git diff failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
    }
    return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function ruleMatches(rule: { paths?: string[]; agent?: string }, context: PolicyContext): boolean {
    if (rule.agent !== undefined && rule.agent !== context.agent) {
        return false;
    }
    if (rule.paths === undefined) {
        return true;
    }
    return rule.paths.some((pattern) => {
        const glob = new Glob(pattern);
        return context.changedFiles.some((file) => glob.match(file));
    });
}

function evaluateGlobs(context: PolicyContext, policy: ResolvedPolicy): PolicyResult {
    const matched = (policy.rules ?? []).filter((rule) => ruleMatches(rule, context));
    if (matched.length === 0) {
        return { decision: "allow", reason: "no policy rule matched" };
    }
    const winner = matched.reduce((best, rule) =>
        DECISION_RANK[rule.decision] < DECISION_RANK[best.decision] ? rule : best,
    );
    const scope = winner.agent !== undefined ? ` agent=${winner.agent}` : "";
    const paths = winner.paths !== undefined ? ` paths=${winner.paths.join(",")}` : "";
    return { decision: winner.decision, reason: `rule decision=${winner.decision}${scope}${paths}` };
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
    return value === "block" || value === "require_approval" || value === "allow";
}

async function evaluateCommand(
    context: PolicyContext,
    policy: ResolvedPolicy,
    exec: PolicyExec,
): Promise<PolicyResult> {
    if (policy.command === undefined || policy.command.length === 0) {
        throw new Error("beflow: policy evaluator is 'command' but policy.command is missing");
    }
    const ran = await exec(policy.command, context.repo, JSON.stringify(context));
    if (ran.exitCode !== 0) {
        throw new Error(`beflow: policy command failed (exit ${String(ran.exitCode)}): ${ran.stderr.trim()}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(ran.stdout);
    } catch {
        throw new Error(`beflow: policy command emitted non-JSON output: ${ran.stdout.trim()}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`beflow: policy command output is not an object: ${ran.stdout.trim()}`);
    }
    const { decision, reason } = parsed as { decision?: unknown; reason?: unknown };
    if (!isPolicyDecision(decision)) {
        throw new Error(`beflow: policy command returned an invalid decision: ${JSON.stringify(decision)}`);
    }
    return { decision, reason: typeof reason === "string" ? reason : "" };
}

/**
 * Apply the resolved policy to a change context. `off` always allows; `globs`
 * runs the rule set with most-restrictive-wins; `command` delegates to an external
 * evaluator and treats any engine failure as a hard error (never a silent allow).
 */
export async function evaluatePolicy(
    context: PolicyContext,
    policy: ResolvedPolicy,
    exec: PolicyExec,
): Promise<PolicyResult> {
    switch (policy.evaluator) {
        case "off":
            return { decision: "allow", reason: "policy disabled" };
        case "globs":
            return evaluateGlobs(context, policy);
        case "command":
            return evaluateCommand(context, policy, exec);
        default: {
            const exhaustive: never = policy.evaluator;
            throw new Error(`beflow: unknown policy evaluator "${String(exhaustive)}"`);
        }
    }
}

/** Default `PolicyExec`: spawn `argv` in `cwd`, write `stdin`, capture stdout/stderr. */
export async function defaultPolicyExec(
    argv: string[],
    cwd: string,
    stdin: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = spawn(argv, { cwd, stderr: "pipe", stdin: new TextEncoder().encode(stdin), stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, stderr, stdout };
}
