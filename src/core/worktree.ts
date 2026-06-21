import { homedir } from "node:os";
import { join } from "node:path";

import { spawn } from "bun";

import { xdgDataHome } from "../config/xdg.ts";

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export function sanitizeKey(key: string): string {
    return key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Expand a leading `~` / `~/` to the home directory; other paths pass through. */
export function expandHome(path: string): string {
    if (path === "~") {
        return homedir();
    }
    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }
    return path;
}

/** Resolve the worktree base dir: the configured value (~-expanded) or the default. */
export function resolveWorktreeDir(configured?: string): string {
    return configured !== undefined ? expandHome(configured) : join(xdgDataHome(), "worktrees");
}

export function worktreePath(baseDir: string, key: string): string {
    return join(baseDir, sanitizeKey(key));
}

async function runGit(repoPath: string, args: string[], exec: Exec): Promise<ExecResult> {
    const fullArgs = ["-C", repoPath, ...args];
    const result = await exec("git", fullArgs);
    if (result.code !== 0) {
        throw new Error(
            `beflow: git ${fullArgs.join(" ")} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
        );
    }
    return result;
}

export async function createWorktree(repoPath: string, key: string, exec: Exec, baseDir: string): Promise<string> {
    const wtPath = worktreePath(baseDir, key);
    const branch = `beflow/${sanitizeKey(key)}`;
    // -B (create-or-reset) rather than -b: createWorktree only runs on the
    // Non-resume path, so any leftover beflow/<key> branch is a stale orphan
    // From an interrupted run and must be reset, not collided with.
    await runGit(repoPath, ["worktree", "add", "-B", branch, wtPath], exec);
    return wtPath;
}

export async function removeWorktree(repoPath: string, wtPath: string, exec: Exec): Promise<void> {
    await runGit(repoPath, ["worktree", "remove", wtPath, "--force"], exec);
}

export async function bunExec(cmd: string, args: string[]): Promise<ExecResult> {
    const proc = spawn([cmd, ...args], { stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { code, stderr, stdout };
}
