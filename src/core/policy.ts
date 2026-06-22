import { isAbsolute, resolve } from "node:path";

import { Glob, file, spawn } from "bun";

import type { ChangeReceipt, PolicyDecision, PolicyRule, ResolvedPolicy } from "../model/types.ts";
import type { Exec } from "./worktree.ts";

/** The change context handed to the policy gate after a run produces a diff. */
export interface PolicyContext {
    agent: string;
    jobKind: string;
    repo: string;
    baseBranch: string;
    changedFiles: string[];
    issueKey: string;
    /**
     * The agent's change receipt, when it emitted one. Additive intent only — globs
     * and agentowners ignore it (paths stay the floor); the `command` evaluator
     * receives it on stdin and may judge it.
     */
    receipt?: ChangeReceipt;
}

/** A single rule that fired during evaluation, in structured form. */
export interface MatchedRule {
    decision: PolicyDecision;
    paths?: string[];
    agent?: string;
}

export interface PolicyResult {
    decision: PolicyDecision;
    reason: string;
    /**
     * The rule(s) that fired, structured. Empty when nothing matched (or the
     * evaluator is `off`/`command`, which do not expose individual rules). This is
     * the machine-readable companion to the flattened `reason` string.
     */
    matchedRules: MatchedRule[];
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

/**
 * Injectable file reader for the agentowners evaluator: returns the file text, or
 * `undefined` when the file is absent. Tests fake this; production uses
 * `defaultPolicyReader`.
 */
export type PolicyReader = (path: string) => Promise<string | undefined>;

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

/** Most-restrictive-wins evaluation of a rule set against a change context. */
function evaluateRules(rules: PolicyRule[], context: PolicyContext): PolicyResult {
    const matched = rules.filter((rule) => ruleMatches(rule, context));
    if (matched.length === 0) {
        return { decision: "allow", matchedRules: [], reason: "no policy rule matched" };
    }
    const winner = matched.reduce((best, rule) =>
        DECISION_RANK[rule.decision] < DECISION_RANK[best.decision] ? rule : best,
    );
    const scope = winner.agent !== undefined ? ` agent=${winner.agent}` : "";
    const paths = winner.paths !== undefined ? ` paths=${winner.paths.join(",")}` : "";
    return {
        decision: winner.decision,
        matchedRules: matched.map((rule) => ({
            decision: rule.decision,
            ...(rule.paths !== undefined ? { paths: rule.paths } : {}),
            ...(rule.agent !== undefined ? { agent: rule.agent } : {}),
        })),
        reason: `rule decision=${winner.decision}${scope}${paths}`,
    };
}

function evaluateGlobs(context: PolicyContext, policy: ResolvedPolicy): PolicyResult {
    return evaluateRules(policy.rules ?? [], context);
}

/**
 * Parse a CODEOWNERS-style AGENTOWNERS file into policy rules. Each non-blank,
 * non-comment line is `<path-glob> <decision> [agent]`; `#` starts a comment.
 * Fails closed: an invalid decision or a malformed line throws rather than being
 * silently skipped, so a broken policy file never degrades to an allow.
 */
export function parseAgentowners(text: string): PolicyRule[] {
    const rules: PolicyRule[] = [];
    for (const [index, line] of text.split("\n").entries()) {
        const stripped = (line.split("#", 1)[0] ?? "").trim();
        if (stripped.length === 0) {
            continue;
        }
        const [glob, decision, agent, ...rest] = stripped.split(/\s+/);
        if (glob === undefined || decision === undefined || rest.length > 0) {
            throw new Error(`beflow: malformed AGENTOWNERS line ${String(index + 1)}: "${line.trim()}"`);
        }
        if (!isPolicyDecision(decision)) {
            throw new Error(`beflow: invalid AGENTOWNERS decision on line ${String(index + 1)}: "${decision}"`);
        }
        rules.push({ decision, paths: [glob], ...(agent !== undefined ? { agent } : {}) });
    }
    return rules;
}

async function evaluateAgentowners(
    context: PolicyContext,
    policy: ResolvedPolicy,
    cwd: string,
    reader: PolicyReader,
): Promise<PolicyResult> {
    const configured = policy.agentownersPath ?? ".github/AGENTOWNERS";
    const path = isAbsolute(configured) ? configured : resolve(cwd, configured);
    const text = await reader(path);
    if (text === undefined) {
        // Fail closed: the gate is selected but its file is missing. Silently allowing
        // would defeat the gate the user opted into, so require human approval until a
        // file exists (run `beflow setup`/`update`, or create it).
        return {
            decision: "require_approval",
            matchedRules: [],
            reason: `agentowners gate is enabled but no file at ${path} — failing closed (require approval); create it or run \`beflow setup\`/\`update\``,
        };
    }
    return evaluateRules(parseAgentowners(text), context);
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
    // The full context — including the change receipt when present — is piped as
    // JSON so external evaluators can judge intent + risk surfaces, not just paths.
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
    return { decision, matchedRules: [], reason: typeof reason === "string" ? reason : "" };
}

/**
 * Apply the resolved policy to a change context. `off` always allows; `globs`
 * runs the rule set with most-restrictive-wins; `agentowners` runs the same engine
 * over a CODEOWNERS-style file (missing file allows, malformed file throws);
 * `command` delegates to an external evaluator and treats any engine failure as a
 * hard error (never a silent allow).
 */
export async function evaluatePolicy(
    context: PolicyContext,
    policy: ResolvedPolicy,
    exec: PolicyExec,
    cwd: string,
    reader: PolicyReader = defaultPolicyReader,
): Promise<PolicyResult> {
    switch (policy.evaluator) {
        case "off":
            return { decision: "allow", matchedRules: [], reason: "policy disabled" };
        case "globs":
            return evaluateGlobs(context, policy);
        case "agentowners":
            return evaluateAgentowners(context, policy, cwd, reader);
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

/** Default `PolicyReader`: read `path` via `Bun.file`, returning `undefined` when absent. */
export async function defaultPolicyReader(path: string): Promise<string | undefined> {
    const handle = file(path);
    if (!(await handle.exists())) {
        return undefined;
    }
    return handle.text();
}
