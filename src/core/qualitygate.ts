import { Glob, spawn } from "bun";

import type { Config, Registry } from "../config/schema.ts";
import type { Exec } from "./worktree.ts";

/**
 * Injectable command runner for the quality gate. Tests fake this; production uses
 * `defaultGateExec`. Returns the process exit code and the combined stdout+stderr.
 */
export type GateExec = (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;

export interface GateResult {
    output: string;
    passed: boolean;
}

const MAX_OUTPUT_CHARS = 16000;

/**
 * Project-over-default resolution of the per-project quality-gate commands. Returns
 * `[]` when neither layer sets `qualityGate.commands` (⇒ the gate is off).
 */
export function resolveQualityGate(config: Config, registry: Registry, projectKey: string): string[] {
    const projectCommands = registry.projects[projectKey]?.qualityGate?.commands;
    const globalCommands = config.qualityGate?.commands;
    return projectCommands ?? globalCommands ?? [];
}

/**
 * Project-over-global-over-default resolution of how many times the pre-PR gate
 * auto-reworks the live agent on RED. Defaults to 1; `0` disables auto-rework.
 */
export function resolveMaxRework(config: Config, registry: Registry, projectKey: string): number {
    return registry.projects[projectKey]?.qualityGate?.maxRework ?? config.qualityGate?.maxRework ?? 1;
}

/**
 * Project-over-global resolution of the test-path globs whose definition-of-passing
 * is pinned to the target branch. Returns `[]` when neither layer sets it (⇒ no
 * baseline pinning; the gate grades against the worktree's own tests).
 */
export function resolveBaselineTestGlobs(config: Config, registry: Registry, projectKey: string): string[] {
    const projectGlobs = registry.projects[projectKey]?.qualityGate?.baselineTestGlobs;
    const globalGlobs = config.qualityGate?.baselineTestGlobs;
    return projectGlobs ?? globalGlobs ?? [];
}

/** A restore handle: undo the baseline pin, returning the worktree's own files. */
export type RestoreBaseline = () => Promise<void>;

/**
 * Pin the gate's baseline: overwrite the worktree's copy of every changed file
 * matching `globs` with the TARGET branch's version, so the gate grades the run's
 * implementation against tests the run could not have weakened in the same branch.
 * Returns a restore handle that puts the worktree's own versions back (the agent's
 * test changes are preserved on the branch; only the gate run sees the baseline).
 * A no-op (returning a no-op restore) when no changed file matches a glob.
 */
export async function pinBaselineTests(
    cwd: string,
    base: string,
    changedFiles: string[],
    globs: string[],
    exec: Exec,
): Promise<RestoreBaseline> {
    const matchers = globs.map((pattern) => new Glob(pattern));
    const matching = changedFiles.filter((file) => matchers.some((glob) => glob.match(file)));

    // Pin only files the run could have weakened: those that EXIST in the base
    // branch (modified or deleted). An added file (absent in base) has no baseline
    // to grade against, so pinning it would (a) error on `checkout base` and (b)
    // wrongly disable the gate — it is simply left as-is.
    const pinned: string[] = [];
    for (const file of matching) {
        if (await existsAtRef(cwd, base, file, exec)) {
            pinned.push(file);
        }
    }
    if (pinned.length === 0) {
        return async (): Promise<void> => {
            /* nothing pinned: nothing to restore */
        };
    }

    // Record each pinned file's TRUE state in HEAD so restore returns the worktree
    // to exactly HEAD: present files are checked out, files the agent deleted are
    // removed again (otherwise the baseline copy would leak past the gate run).
    const presentInHead: string[] = [];
    const deletedInHead: string[] = [];
    for (const file of pinned) {
        if (await existsAtRef(cwd, "HEAD", file, exec)) {
            presentInHead.push(file);
        } else {
            deletedInHead.push(file);
        }
    }

    await runGit(cwd, ["checkout", base, "--", ...pinned], exec);
    return async (): Promise<void> => {
        if (presentInHead.length > 0) {
            await runGit(cwd, ["checkout", "HEAD", "--", ...presentInHead], exec);
        }
        if (deletedInHead.length > 0) {
            await runGit(cwd, ["rm", "-f", "--", ...deletedInHead], exec);
        }
    };
}

/**
 * Whether `path` exists at `ref`, via `git cat-file -e <ref>:<path>`. A non-zero
 * exit is the EXPECTED "absent" answer, not an error — so it returns `false`
 * rather than throwing. Genuine failures still surface through `runGit` callers.
 */
async function existsAtRef(cwd: string, ref: string, path: string, exec: Exec): Promise<boolean> {
    const result = await exec("git", ["-C", cwd, "cat-file", "-e", `${ref}:${path}`]);
    return result.code === 0;
}

async function runGit(cwd: string, args: string[], exec: Exec): Promise<void> {
    const fullArgs = ["-C", cwd, ...args];
    const result = await exec("git", fullArgs);
    if (result.code !== 0) {
        throw new Error(
            `beflow: git ${fullArgs.join(" ")} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
        );
    }
}

/** Truncate from the front, keeping the tail (where errors usually surface). */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return `…(truncated)…\n${text.slice(text.length - MAX_OUTPUT_CHARS)}`;
}

/**
 * Run each command sequentially in `cwd`. The FIRST non-zero exit makes `passed:false`
 * and stops (later commands are not run); the combined stdout+stderr of every command
 * run so far is captured into `output` (truncated to a sane cap).
 */
export async function runQualityGate(commands: string[], cwd: string, exec: GateExec): Promise<GateResult> {
    const chunks: string[] = [];
    for (const command of commands) {
        const ran = await exec(command, cwd);
        chunks.push(`$ ${command}\n${ran.output}`);
        if (ran.exitCode !== 0) {
            return { output: truncate(chunks.join("\n\n")), passed: false };
        }
    }
    return { output: truncate(chunks.join("\n\n")), passed: true };
}

/**
 * Default runner: shell-parse the command string into an argv and spawn it in `cwd`,
 * mirroring `bunExec` (no shell, argv array). Combines stdout and stderr into `output`.
 */
export async function defaultGateExec(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const argv = parts.map((p) => p.replace(/^["']|["']$/g, ""));
    if (argv.length === 0) {
        return { exitCode: 0, output: "" };
    }
    const proc = spawn(argv, { cwd, stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, output: stdout + stderr };
}
