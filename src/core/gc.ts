import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { listRecords, nodeRunStoreFs, systemClock } from "./runstore.ts";
import type { Clock, RunStoreFs } from "./runstore.ts";
import { removeWorktree, sanitizeKey } from "./worktree.ts";
import type { Exec } from "./worktree.ts";

export interface GcFs {
    listDirs(dir: string): string[];
    mtimeMs(path: string): number;
    removeDir(path: string): void;
}

export const nodeGcFs: GcFs = {
    listDirs(dir) {
        try {
            return readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        } catch {
            return [];
        }
    },
    mtimeMs(path) {
        try {
            return statSync(path).mtimeMs;
        } catch {
            return 0;
        }
    },
    removeDir(path) {
        rmSync(path, { force: true, recursive: true });
    },
};

export interface OrphanWorktree {
    name: string;
    path: string;
    repoPath?: string;
    dirty: boolean;
    unpushed: boolean;
    ageDays: number;
    safe: boolean;
    heldReason?: string;
}

const MS_PER_DAY = 86_400_000;

function clockMs(clock: Clock): number {
    const parsed = Date.parse(clock());
    return Number.isNaN(parsed) ? 0 : parsed;
}

// Parses `git worktree list --porcelain` and returns the FIRST `worktree <path>`
// line, which is always the source (main) repository. undefined when the output
// has no such line.
function parseSourceRepo(stdout: string): string | undefined {
    for (const line of stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
            return line.slice("worktree ".length).trim();
        }
    }
    return undefined;
}

async function inspectOrphan(path: string, ageDays: number, git: Exec): Promise<OrphanWorktree> {
    const name = path.slice(path.lastIndexOf("/") + 1);

    const listed = await git("git", ["-C", path, "worktree", "list", "--porcelain"]);
    const repoPath = listed.code === 0 ? parseSourceRepo(listed.stdout) : undefined;
    if (repoPath === undefined) {
        return {
            ageDays,
            dirty: false,
            heldReason: "unregistered/broken worktree",
            name,
            path,
            safe: false,
            unpushed: false,
        };
    }

    const status = await git("git", ["-C", path, "status", "--porcelain"]);
    const dirty = status.code !== 0 || status.stdout.trim().length > 0;

    const revList = await git("git", ["-C", path, "rev-list", "HEAD", "--not", "--remotes"]);
    const unpushed = revList.code !== 0 || revList.stdout.trim().length > 0;

    const reason = dirty ? "uncommitted changes" : unpushed ? "unpushed commits" : undefined;
    return {
        ageDays,
        dirty,
        name,
        path,
        repoPath,
        safe: !dirty && !unpushed,
        unpushed,
        ...(reason !== undefined ? { heldReason: reason } : {}),
    };
}

export async function collectOrphans(opts: {
    worktreesDir: string;
    runsDir: string;
    git: Exec;
    fs?: GcFs;
    runsFs?: RunStoreFs;
    clock?: Clock;
}): Promise<OrphanWorktree[]> {
    const fs = opts.fs ?? nodeGcFs;
    const runsFs = opts.runsFs ?? nodeRunStoreFs;
    const clock = opts.clock ?? systemClock;
    const now = clockMs(clock);

    const recorded = new Set(listRecords(opts.runsDir, runsFs).map((r) => sanitizeKey(r.key)));

    const orphans: OrphanWorktree[] = [];
    for (const name of fs.listDirs(opts.worktreesDir)) {
        if (recorded.has(name)) {
            continue;
        }
        const path = join(opts.worktreesDir, name);
        const ageDays = (now - fs.mtimeMs(path)) / MS_PER_DAY;
        orphans.push(await inspectOrphan(path, ageDays, opts.git));
    }
    return orphans;
}

export interface GcPlan {
    pruned: OrphanWorktree[];
    held: OrphanWorktree[];
    skippedByAge: OrphanWorktree[];
}

async function removeOrphan(orphan: OrphanWorktree, git: Exec, fs: GcFs): Promise<void> {
    if (orphan.repoPath !== undefined) {
        try {
            await removeWorktree(orphan.repoPath, orphan.path, git);
            return;
        } catch {
            // `git worktree remove` failed (e.g. locked/corrupt); fall back to
            // a raw recursive delete plus a best-effort prune of the dangling
            // administrative entry in the source repo.
        }
    }
    fs.removeDir(orphan.path);
    if (orphan.repoPath !== undefined) {
        await git("git", ["-C", orphan.repoPath, "worktree", "prune"]);
    }
}

export async function runGc(opts: {
    worktreesDir: string;
    runsDir: string;
    git: Exec;
    fs?: GcFs;
    runsFs?: RunStoreFs;
    clock?: Clock;
    prune?: boolean;
    force?: boolean;
    olderThanDays?: number;
    log?: (m: string) => void;
}): Promise<GcPlan> {
    const fs = opts.fs ?? nodeGcFs;
    const log =
        opts.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const collectOpts: Parameters<typeof collectOrphans>[0] = {
        git: opts.git,
        runsDir: opts.runsDir,
        worktreesDir: opts.worktreesDir,
        ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
        ...(opts.runsFs !== undefined ? { runsFs: opts.runsFs } : {}),
        ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    };
    const orphans = await collectOrphans(collectOpts);

    const plan: GcPlan = { held: [], pruned: [], skippedByAge: [] };
    const force = opts.force === true;
    const prune = opts.prune === true;

    for (const orphan of orphans) {
        if (opts.olderThanDays !== undefined && orphan.ageDays < opts.olderThanDays) {
            plan.skippedByAge.push(orphan);
            continue;
        }
        const isTarget = force || orphan.safe;
        if (isTarget) {
            plan.pruned.push(orphan);
        } else {
            plan.held.push(orphan);
        }
    }

    if (prune) {
        for (const orphan of plan.pruned) {
            await removeOrphan(orphan, opts.git, fs);
            log(`gc: removed orphan worktree ${orphan.path}`);
        }
    } else {
        for (const orphan of plan.pruned) {
            log(`gc: would remove orphan worktree ${orphan.path}`);
        }
    }

    for (const orphan of plan.held) {
        log(`gc: held ${orphan.path} — ${orphan.heldReason ?? "not safe"} (re-run with --force to remove)`);
    }
    for (const orphan of plan.skippedByAge) {
        log(`gc: skipped ${orphan.path} — newer than threshold`);
    }

    log(
        `gc: ${String(orphans.length)} orphan worktree(s) — ${String(plan.pruned.length)} ${
            prune ? "pruned" : "to prune"
        }, ${String(plan.held.length)} held (use --force), ${String(plan.skippedByAge.length)} too new`,
    );

    return plan;
}
