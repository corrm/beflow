import { describe, expect, it } from "bun:test";

import { collectOrphans, runGc } from "../src/core/gc.ts";
import type { GcFs } from "../src/core/gc.ts";
import type { Clock, RunRecord, RunStoreFs } from "../src/core/runstore.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";

const WORKTREES = "/wt";
const RUNS = "/runs";

const fixedClock: Clock = () => "2026-06-16T00:00:00.000Z";

interface GitCall {
    args: string[];
}

// Per-worktree-path canned git behaviour. A path absent from the map is treated
// as a broken/unregistered worktree (worktree list fails).
interface WtSpec {
    repo?: string;
    dirty?: boolean;
    unpushed?: boolean;
    removeFails?: boolean;
}

function ok(stdout: string): ExecResult {
    return { code: 0, stderr: "", stdout };
}

function fail(): ExecResult {
    return { code: 1, stderr: "boom", stdout: "" };
}

// Routes git invocations by subcommand and by the `-C <path>` target.
function fakeGit(specs: Record<string, WtSpec>): { git: Exec; calls: GitCall[] } {
    const calls: GitCall[] = [];
    const git: Exec = async (_cmd, args) => {
        calls.push({ args });
        const cIdx = args.indexOf("-C");
        const target = cIdx >= 0 ? args[cIdx + 1] : undefined;

        // `worktree remove <path> --force` runs `-C <repo>`, so locate the spec
        // by the path argument that follows `remove`.
        if (args.includes("worktree") && args.includes("remove")) {
            const removeIdx = args.indexOf("remove");
            const wtPath = args[removeIdx + 1] ?? "";
            const name = wtPath.slice(wtPath.lastIndexOf("/") + 1);
            return specs[name]?.removeFails === true ? fail() : ok("");
        }
        if (args.includes("worktree") && args.includes("prune")) {
            return ok("");
        }

        const name = target !== undefined ? target.slice(target.lastIndexOf("/") + 1) : "";
        const spec = specs[name];
        if (args.includes("worktree") && args.includes("list")) {
            if (spec?.repo === undefined) {
                return fail();
            }
            return ok(`worktree ${spec.repo}\nHEAD abc\nbranch refs/heads/main\n`);
        }
        if (args.includes("status")) {
            return spec?.dirty === true ? ok(" M file.ts\n") : ok("");
        }
        if (args.includes("rev-list")) {
            return spec?.unpushed === true ? ok("deadbeef\n") : ok("");
        }
        return ok("");
    };
    return { calls, git };
}

function memRunsFs(records: RunRecord[]): RunStoreFs {
    const store = new Map<string, string>();
    for (const rec of records) {
        store.set(`${RUNS}/${rec.key.toLowerCase()}.json`, JSON.stringify(rec));
    }
    return {
        list: (dir) => [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
        read: (path) => store.get(path) ?? null,
        remove: (path) => {
            store.delete(path);
        },
        write: (path, data) => {
            store.set(path, data);
        },
    };
}

// names: worktree subdir names; mtimes: ms per name (defaults to a far-past
// value so age comfortably exceeds any threshold).
function memGcFs(names: string[], mtimes: Record<string, number> = {}): { fs: GcFs; removed: string[] } {
    const removed: string[] = [];
    const fs: GcFs = {
        listDirs: (dir) => (dir === WORKTREES ? names : []),
        mtimeMs: (path) => {
            const name = path.slice(path.lastIndexOf("/") + 1);
            return mtimes[name] ?? 0;
        },
        removeDir: (path) => {
            removed.push(path);
        },
    };
    return { fs, removed };
}

function record(key: string): RunRecord {
    return {
        agent: "claude",
        cwd: `/wt/${key.toLowerCase()}`,
        key,
        jobKind: "implement",
        runMode: "autonomous",
        sessionName: "s",
        status: "in_progress",
        updatedAt: "2026-06-16T00:00:00.000Z",
    };
}

describe("collectOrphans", () => {
    it("never treats a worktree with a run-record as an orphan", async () => {
        const { git } = fakeGit({ "cg-1": { repo: "/repo" }, "cg-2": { repo: "/repo" } });
        const { fs } = memGcFs(["cg-1", "cg-2"]);
        const orphans = await collectOrphans({
            clock: fixedClock,
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([record("CG-1")]),
            worktreesDir: WORKTREES,
        });
        expect(orphans.map((o) => o.name)).toEqual(["cg-2"]);
    });

    it("classifies clean+pushed+registered as safe", async () => {
        const { git } = fakeGit({ "cg-9": { repo: "/repo/bin" } });
        const { fs } = memGcFs(["cg-9"]);
        const [orphan] = await collectOrphans({
            clock: fixedClock,
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(orphan?.safe).toBe(true);
        expect(orphan?.repoPath).toBe("/repo/bin");
        expect(orphan?.heldReason).toBeUndefined();
    });

    it("holds dirty and unpushed worktrees with reasons", async () => {
        const { git } = fakeGit({
            "cg-dirty": { dirty: true, repo: "/repo" },
            "cg-unpushed": { repo: "/repo", unpushed: true },
        });
        const { fs } = memGcFs(["cg-dirty", "cg-unpushed"]);
        const orphans = await collectOrphans({
            clock: fixedClock,
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        const dirty = orphans.find((o) => o.name === "cg-dirty");
        const unpushed = orphans.find((o) => o.name === "cg-unpushed");
        expect(dirty?.safe).toBe(false);
        expect(dirty?.heldReason).toBe("uncommitted changes");
        expect(unpushed?.safe).toBe(false);
        expect(unpushed?.heldReason).toBe("unpushed commits");
    });

    it("holds a broken/unregistered worktree", async () => {
        const { git } = fakeGit({});
        const { fs } = memGcFs(["cg-broken"]);
        const [orphan] = await collectOrphans({
            clock: fixedClock,
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(orphan?.safe).toBe(false);
        expect(orphan?.repoPath).toBeUndefined();
        expect(orphan?.heldReason).toBe("unregistered/broken worktree");
    });

    it("computes ageDays from the injected clock and fake mtime", async () => {
        const { git } = fakeGit({ "cg-old": { repo: "/repo" } });
        const nowMs = Date.parse("2026-06-16T00:00:00.000Z");
        const tenDaysAgo = nowMs - 10 * 86_400_000;
        const { fs } = memGcFs(["cg-old"], { "cg-old": tenDaysAgo });
        const [orphan] = await collectOrphans({
            clock: fixedClock,
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(orphan?.ageDays).toBeCloseTo(10, 5);
    });
});

describe("runGc", () => {
    it("report-only (no --prune) deletes nothing regardless of safety", async () => {
        const { calls, git } = fakeGit({
            "cg-broken": {},
            "cg-dirty": { dirty: true, repo: "/repo" },
            "cg-safe": { repo: "/repo" },
        });
        const { fs, removed } = memGcFs(["cg-safe", "cg-dirty", "cg-broken"]);
        const plan = await runGc({
            fs,
            git,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(plan.pruned.map((o) => o.name)).toEqual(["cg-safe"]);
        expect(plan.held.map((o) => o.name).sort()).toEqual(["cg-broken", "cg-dirty"]);
        expect(removed).toEqual([]);
        expect(calls.some((c) => c.args.includes("remove"))).toBe(false);
    });

    it("--prune removes a safe orphan via worktree remove with the discovered repo", async () => {
        const { calls, git } = fakeGit({ "cg-safe": { repo: "/repo/bin" } });
        const { fs } = memGcFs(["cg-safe"]);
        const plan = await runGc({
            fs,
            git,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(plan.pruned.map((o) => o.name)).toEqual(["cg-safe"]);
        const removeCall = calls.find((c) => c.args.includes("remove"));
        expect(removeCall?.args).toEqual(["-C", "/repo/bin", "worktree", "remove", "/wt/cg-safe", "--force"]);
    });

    it("holds dirty/unpushed under --prune, removes them under --prune --force", async () => {
        const specs = { "cg-dirty": { dirty: true, repo: "/repo" }, "cg-unpushed": { repo: "/repo", unpushed: true } };

        const held = await runGc({
            fs: memGcFs(["cg-dirty", "cg-unpushed"]).fs,
            git: fakeGit(specs).git,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(held.pruned).toEqual([]);
        expect(held.held.map((o) => o.name).sort()).toEqual(["cg-dirty", "cg-unpushed"]);

        const forced = fakeGit(specs);
        const plan = await runGc({
            force: true,
            fs: memGcFs(["cg-dirty", "cg-unpushed"]).fs,
            git: forced.git,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(plan.pruned.map((o) => o.name).sort()).toEqual(["cg-dirty", "cg-unpushed"]);
        expect(plan.held).toEqual([]);
        expect(forced.calls.filter((c) => c.args.includes("remove"))).toHaveLength(2);
    });

    it("removes a broken worktree via the removeDir fallback under --force", async () => {
        const { calls, git } = fakeGit({});
        const { fs, removed } = memGcFs(["cg-broken"]);
        const plan = await runGc({
            force: true,
            fs,
            git,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(plan.pruned.map((o) => o.name)).toEqual(["cg-broken"]);
        expect(removed).toEqual(["/wt/cg-broken"]);
        // repoPath is unknown, so no `git worktree remove`/`prune` is attempted.
        expect(calls.some((c) => c.args.includes("remove") || c.args.includes("prune"))).toBe(false);
    });

    it("falls back to removeDir + prune when worktree remove fails", async () => {
        const { calls, git } = fakeGit({ "cg-safe": { removeFails: true, repo: "/repo/bin" } });
        const { fs, removed } = memGcFs(["cg-safe"]);
        await runGc({
            fs,
            git,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(removed).toEqual(["/wt/cg-safe"]);
        const pruneCall = calls.find((c) => c.args.includes("prune"));
        expect(pruneCall?.args).toEqual(["-C", "/repo/bin", "worktree", "prune"]);
    });

    it("keeps too-new orphans out of removal via --older-than", async () => {
        const nowMs = Date.parse("2026-06-16T00:00:00.000Z");
        const { calls, git } = fakeGit({ "cg-new": { repo: "/repo" }, "cg-old": { repo: "/repo" } });
        const { fs } = memGcFs(["cg-new", "cg-old"], {
            "cg-new": nowMs - 1 * 86_400_000,
            "cg-old": nowMs - 30 * 86_400_000,
        });
        const plan = await runGc({
            clock: fixedClock,
            fs,
            git,
            olderThanDays: 7,
            prune: true,
            runsDir: RUNS,
            runsFs: memRunsFs([]),
            worktreesDir: WORKTREES,
        });
        expect(plan.pruned.map((o) => o.name)).toEqual(["cg-old"]);
        expect(plan.skippedByAge.map((o) => o.name)).toEqual(["cg-new"]);
        const removeCalls = calls.filter((c) => c.args.includes("remove"));
        expect(removeCalls).toHaveLength(1);
        expect(removeCalls[0]?.args).toContain("/wt/cg-old");
    });
});
