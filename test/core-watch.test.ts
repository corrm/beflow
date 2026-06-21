import { describe, expect, it } from "bun:test";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import { QUARANTINED_LABEL } from "../src/core/deadletter.ts";
import type { NotifyEvent, Notifier } from "../src/core/notify.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import type { RunReviewDeps } from "../src/core/review.ts";
import type { Clock, RunStoreFs } from "../src/core/runstore.ts";
import { loadRecord, saveRecord } from "../src/core/runstore.ts";
import { watch, watchTick } from "../src/core/watch.ts";
import type { WatchDeps } from "../src/core/watch.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import {
    IssueNotFoundError,
    type BlockerRef,
    type BoardState,
    type Comment,
    type EnsureBoardResult,
    type IntakeItem,
    type IssueContext,
    type IssueDraft,
    type ProjectCreateResult,
    type QueueFilter,
    type Tracker,
} from "../src/trackers/tracker.ts";

const config: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    runs: { dir: "/runs" },
    tracker: "plane",
    trackers: {},
};

const registry: Registry = {
    projects: {
        CG: {
            default_repo: "bin",
            module_repo_map: {},
            name: "My App",
            plane_project_id: "pid",
            repos: { bin: "/repo/bin" },
            root: "/root",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

function issue(over: Partial<Issue> & { key: string }): Issue {
    return {
        areas: [],
        body: "",
        id: over.key,
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "t",
        type: "Bug",
        ...over,
    };
}

interface WatchQueues {
    inReview: Issue[];
    todo: Issue[];
    inProgress?: Issue[];
    needsInput?: Issue[];
    // Keyed by issue key; the blocked-by relations reported for that issue.
    blockers?: Record<string, BlockerRef[]>;
    // When set, blockedBy throws this error for the given key (per-tick guard test).
    blockerErrors?: Record<string, Error>;
    // Keyed by issue key; returns the comment history for that issue.
    comments?: Record<string, Comment[]>;
    // Keyed by issue key; overrides the state returned by getIssue. Defaults to a
    // Started-group "In Progress" state, matching a live/crashed beflow run.
    issueStates?: Record<string, { name: string; group: Issue["state"]["group"] }>;
    // Keyed by issue key; when set, getIssue throws this error instead of returning.
    issueErrors?: Record<string, Error>;
    // Keyed by issue key; when true, getIssue returns an archived issue.
    archived?: Record<string, boolean>;
    // Active-cycle membership for cycle-aware scheduling. undefined → null (no
    // Determinable cycle, dispatch unfiltered); a Set narrows Todo to its members.
    cycleIds?: Set<string> | null;
}

interface TrackerCall {
    stateUpdates: { key: string; state: string }[];
    addedLabels: { key: string; label: string }[];
    removedLabels: { key: string; label: string }[];
    posted: { key: string; body: string }[];
}

class WatchTracker implements Tracker {
    readonly calls: TrackerCall = { addedLabels: [], posted: [], removedLabels: [], stateUpdates: [] };
    constructor(private readonly queues: WatchQueues) {}
    async getIssue(key: string): Promise<Issue> {
        const err = this.queues.issueErrors?.[key];
        if (err !== undefined) {
            throw err;
        }
        const override = this.queues.issueStates?.[key];
        return issue({
            archived: this.queues.archived?.[key] ?? false,
            key,
            state: override ?? { group: "started", name: "In Progress" },
        });
    }
    async createIssue(_project: string, draft: IssueDraft): Promise<Issue> {
        return issue({ key: "CG-NEW", title: draft.title });
    }
    async blockedBy(i: Issue): Promise<BlockerRef[]> {
        const err = this.queues.blockerErrors?.[i.key];
        if (err !== undefined) {
            throw err;
        }
        return this.queues.blockers?.[i.key] ?? [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return this.queues.cycleIds ?? null;
    }
    async listQueue(f: QueueFilter): Promise<Issue[]> {
        if (f.state === "In Review") {
            return this.queues.inReview;
        }
        if (f.state === "Todo") {
            return this.queues.todo;
        }
        if (f.state === "In Progress") {
            return this.queues.inProgress ?? [];
        }
        if (f.state === "Needs Input") {
            return this.queues.needsInput ?? [];
        }
        return [];
    }
    async updateState(i: Issue, stateName: string): Promise<void> {
        this.calls.stateUpdates.push({ key: i.key, state: stateName });
    }
    async assign(): Promise<void> {}
    async addProperty(i: Issue, name: string): Promise<void> {
        this.calls.addedLabels.push({ key: i.key, label: name });
    }
    async removeProperty(i: Issue, name: string): Promise<void> {
        this.calls.removedLabels.push({ key: i.key, label: name });
    }
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(i: Issue, body: string): Promise<void> {
        this.calls.posted.push({ body, key: i.key });
        const list = this.queues.comments?.[i.key];
        if (list !== undefined) {
            list.push({ body, createdAt: "2026-06-15T00:00:00.000Z", id: `c${String(list.length)}`, isBot: true });
        }
    }
    async listComments(i: Issue): Promise<Comment[]> {
        return this.queues.comments?.[i.key] ?? [];
    }
    async linkPR(): Promise<void> {}
    readMetadata(i: Issue): IssueMeta {
        return i.meta;
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return {
            labels: ["blocked", "triaged"],
            modules: [],
            states: ["Backlog", "Todo", "In Progress", "Needs Input", "In Review", "Done"],
            types: [],
        };
    }
    async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
    async verifyAuth(): Promise<void> {}
}

function fakeDriver(): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report: { status: "done", summary: "s" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };
    return { driver, seen };
}

function throwingDriver(): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            throw new Error("agent exploded");
        },
    };
    return { driver, seen };
}

function memRunsFs(): { fs: RunStoreFs; store: Map<string, string> } {
    const store = new Map<string, string>();
    const fs: RunStoreFs = {
        append: (path, data) => {
            store.set(path, `${store.get(path) ?? ""}${data}`);
        },
        list: (dir) => [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
        read: (path) => store.get(path) ?? null,
        remove: (path) => {
            store.delete(path);
        },
        write: (path, data) => {
            store.set(path, data);
        },
    };
    return { fs, store };
}

const fixedClock: Clock = () => "2026-06-14T00:00:00.000Z";

function spyNotifier(): { events: NotifyEvent[]; notifier: Notifier } {
    const events: NotifyEvent[] = [];
    const notifier: Notifier = {
        notify: async (evt: NotifyEvent): Promise<void> => {
            events.push(evt);
        },
    };
    return { events, notifier };
}

function slaRegistry(sla: { inReviewMinutes?: number; needsInputMinutes?: number }): Registry {
    return {
        ...registry,
        projects: { CG: { ...registry.projects.CG!, sla } },
    };
}

function cycleRegistry(activeCycleOnly: boolean): Registry {
    return {
        ...registry,
        projects: { CG: { ...registry.projects.CG!, scheduling: { activeCycleOnly } } },
    };
}

function ciRegistry(autoReworkOnRed: boolean): Registry {
    return {
        ...registry,
        projects: { CG: { ...registry.projects.CG!, ci: { autoReworkOnRed } } },
    };
}

function beflowOwnedRegistry(autoReworkOnRed = false): Registry {
    return {
        ...registry,
        projects: {
            CG: {
                ...registry.projects.CG!,
                ...(autoReworkOnRed ? { ci: { autoReworkOnRed } } : {}),
                pr: { owner: "beflow" },
            },
        },
    };
}

// The continuation template renders one of two PR instructions; assert on the
// Marker phrase unique to each so the tests prove which ownership was selected.
const AGENT_OWNED_MARKER = "UPDATE it — do not open a new one";
const BEFLOW_OWNED_MARKER = "do NOT run `gh pr create`";

const prompts = loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });

function deps(over: Partial<WatchDeps> & { tracker: Tracker; driver: AgentDriver }): WatchDeps {
    return {
        clock: fixedClock,
        config,
        prompts,
        registry,
        runsFs: memRunsFs().fs,
        ...over,
    };
}

describe("watchTick", () => {
    it("returns at-capacity when In Review is at the per-project cap", async () => {
        const registryWithCap: Registry = {
            ...registry,
            projects: {
                CG: { ...registry.projects.CG!, limits: { inReview: 2 } },
            },
        };
        const tracker = new WatchTracker({
            inReview: [issue({ key: "CG-1" }), issue({ key: "CG-2" })],
            todo: [issue({ key: "CG-9" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: registryWithCap, tracker }));
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("returns idle when Todo is empty", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("dispatches Todos via the run path up to the remaining cap, top priority first", async () => {
        // Default In Progress cap is 3 and nothing is in progress, so both eligible
        // Todos dispatch in one tick; the representative action carries the top key.
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        expect(seen).toHaveLength(2);
        expect(seen.map((s) => s.sessionKey).sort()).toEqual(["CG-7", "CG-8"]);
        expect(seen.every((s) => s.runMode === "autonomous")).toBe(true);
    });

    it("parks a thin Todo issue to Needs Input instead of dispatching", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ body: "<p>thin</p>", key: "CG-7" })],
        });
        const thinRegistry: Registry = {
            ...registry,
            projects: { ...registry.projects, CG: { ...registry.projects.CG!, inputQuality: { minBodyChars: 50 } } },
        };
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: thinRegistry, tracker }));
        expect(out).toEqual({ action: "parked", key: "CG-7" });
        // The agent never ran; the card moved to Needs Input.
        expect(seen).toHaveLength(0);
        expect(tracker.calls.stateUpdates.some((c) => c.key === "CG-7" && c.state === "Needs Input")).toBe(true);
    });

    it("isolates a failing dispatch as an error action without throwing", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7" })],
        });
        const { driver } = throwingDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "error", key: "CG-7" });
    });

    it("skips a Todo whose blocker is undone and dispatches the next eligible one", async () => {
        const tracker = new WatchTracker({
            blockers: {
                "CG-7": [{ done: false, key: "CG-5" }],
            },
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                log: (m) => {
                    logs.push(m);
                },
                tracker,
            }),
        );
        expect(out).toEqual({ action: "dispatched", key: "CG-8" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.sessionKey).toBe("CG-8");
        expect(logs.some((l) => l.includes("CG-7 skipped: blocked-by CG-5 (not done)"))).toBe(true);
    });

    it("dispatches the top Todo (and the rest of the batch) when all its blockers are done", async () => {
        const tracker = new WatchTracker({
            blockers: {
                "CG-7": [
                    { done: true, key: "CG-5" },
                    { done: true, key: "CG-6" },
                ],
            },
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        expect(seen).toHaveLength(2);
        expect(seen.map((s) => s.sessionKey).sort()).toEqual(["CG-7", "CG-8"]);
    });

    it("goes idle and logs when every Todo is blocked", async () => {
        const tracker = new WatchTracker({
            blockers: {
                "CG-7": [{ done: false, key: "CG-5" }],
                "CG-8": [{ done: false, key: "CG-6" }],
            },
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                log: (m) => {
                    logs.push(m);
                },
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
        expect(logs.some((l) => l.includes("all Todo blocked; idle"))).toBe(true);
    });

    it("dispatches the batch when there are no relations at all (regression)", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        expect(seen).toHaveLength(2);
        expect(seen.map((s) => s.sessionKey).sort()).toEqual(["CG-7", "CG-8"]);
    });

    it("lets a blockedBy fetch failure bubble to the per-tick guard (not treated as unblocked)", async () => {
        const tracker = new WatchTracker({
            blockerErrors: { "CG-7": new Error("relations boom") },
            inReview: [],
            todo: [issue({ key: "CG-7" })],
        });
        const { driver, seen } = fakeDriver();
        expect(watchTick("CG", deps({ driver, tracker }))).rejects.toThrow(/relations boom/);
        expect(seen).toHaveLength(0);
    });

    it("enforces a per-project In Review override below the safety floor", async () => {
        const registryWithCap: Registry = {
            ...registry,
            projects: {
                CG: { ...registry.projects.CG!, limits: { inReview: 1 } },
            },
        };
        const tracker = new WatchTracker({
            inReview: [issue({ key: "CG-1" })],
            todo: [issue({ key: "CG-9" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: registryWithCap, tracker }));
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("falls back to the built-in In Review safety floor (5) when a project sets no limits", async () => {
        // No per-project limits; the built-in floor is 5. Four In Review items are
        // Under it, so it dispatches.
        const tracker = new WatchTracker({
            inReview: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" }), issue({ key: "CG-4" })],
            todo: [issue({ key: "CG-9" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-9" });
        expect(seen).toHaveLength(1);
    });

    it("returns at-capacity at the built-in In Review safety floor (5) when a project sets no limits", async () => {
        const tracker = new WatchTracker({
            inReview: [
                issue({ key: "CG-1" }),
                issue({ key: "CG-2" }),
                issue({ key: "CG-3" }),
                issue({ key: "CG-4" }),
                issue({ key: "CG-5" }),
            ],
            todo: [issue({ key: "CG-9" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("isolates a cross-tracker resume as an error without throwing out of the loop", async () => {
        const tracker = new WatchTracker({
            inProgress: [issue({ key: "CG-5" })],
            inReview: [],
            todo: [],
        });
        const { fs } = memRunsFs();
        // Cwd must exist on disk for runIssue to take the resume branch where the
        // Cross-tracker guard fires; use the current working directory.
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: process.cwd(),
                key: "CG-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                tracker: "linear",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                git: async () => ({ code: 0, stdout: "", stderr: "" }),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "error", key: "CG-5" });
    });

    it("honors getSnapshot over the stale deps.config/registry", async () => {
        // Deps.config cap is 2 (would dispatch with one In Review item), but the
        // Live snapshot sets a per-project cap of 1, so the tick reports at-capacity.
        const snapRegistry: Registry = {
            ...registry,
            projects: {
                CG: { ...registry.projects.CG!, limits: { inReview: 1 } },
            },
        };
        const tracker = new WatchTracker({
            inReview: [issue({ key: "CG-1" })],
            todo: [issue({ key: "CG-9" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                getSnapshot: () => ({ config, registry: snapRegistry }),
                tracker,
            }),
        );
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("resumes an In Progress issue that has an in_progress record", async () => {
        const tracker = new WatchTracker({
            inProgress: [issue({ key: "CG-5" })],
            inReview: [],
            todo: [issue({ key: "CG-7" })],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "resumed", key: "CG-5" });
        expect(seen[0]!.sessionKey).toBe("CG-5");
    });

    it("record-driven resume: resumes an autonomous in_progress record with no board lookup", async () => {
        // No In Progress board item — the resume is driven purely by the run store.
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "resumed", key: "CG-5" });
        expect(seen[0]!.sessionKey).toBe("CG-5");
    });

    it("record-driven resume: does NOT resume a supervised record", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-5",
                jobKind: "implement",
                runMode: "supervised",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("record-driven resume: skips a record whose key belongs to a different project", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "ZZ-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "ZZ-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("quarantine: a record at the resume cap is quarantined in Needs Input", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
        const { events, notifier } = spyNotifier();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 3,
                cwd: "/repo/bin",
                key: "CG-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "quarantined", key: "CG-5" });
        // The agent is never re-dispatched.
        expect(seen).toHaveLength(0);
        expect(tracker.calls.stateUpdates).toEqual([{ key: "CG-5", state: "Needs Input" }]);
        expect(tracker.calls.addedLabels).toEqual([{ key: "CG-5", label: "quarantined" }]);
        // The reason is posted to the board (independent of any webhook).
        expect(tracker.calls.posted).toHaveLength(1);
        expect(tracker.calls.posted[0]!.body).toContain("failed attempts");
        expect(events.filter((e) => e.reason === "failed")).toHaveLength(1);
        // The record is held as a quarantine, not deleted; the universal counter is preserved.
        const rec = loadRecord("/runs", "CG-5", fs);
        expect(rec?.status).toBe("failed");
        expect(rec?.heldReason).toBe("quarantine");
    });

    it("reconcile: a manual move out of started cleans up and does not resume", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            issueStates: { "CG-5": { group: "cancelled", name: "Cancelled" } },
            todo: [],
        });
        const { fs } = memRunsFs();
        const gitCalls: string[][] = [];
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-5",
                key: "CG-5",
                jobKind: "implement",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                git: async (cmd, args) => {
                    gitCalls.push([cmd, ...args]);
                    return { code: 0, stderr: "", stdout: "" };
                },
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "reconciled", key: "CG-5" });
        // The agent is never re-dispatched.
        expect(seen).toHaveLength(0);
        // The worktree was removed and the record deleted.
        expect(gitCalls.some((c) => c.includes("remove"))).toBe(true);
        expect(loadRecord("/runs", "CG-5", fs)).toBeNull();
    });

    it("reconcile GONE: a deleted issue parks the run, drops the record, and leaves the worktree", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            issueErrors: { "CG-5": new IssueNotFoundError("CG-5") },
            todo: [],
        });
        const { fs } = memRunsFs();
        const gitCalls: string[][] = [];
        const logs: string[] = [];
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-5",
                key: "CG-5",
                jobKind: "implement",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                git: async (cmd, args) => {
                    gitCalls.push([cmd, ...args]);
                    return { code: 0, stderr: "", stdout: "" };
                },
                log: (m) => {
                    logs.push(m);
                },
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "orphaned", key: "CG-5" });
        // No agent dispatched, record dropped.
        expect(seen).toHaveLength(0);
        expect(loadRecord("/runs", "CG-5", fs)).toBeNull();
        // The worktree was NOT removed — leave possibly-unpushed work for a human.
        expect(gitCalls.some((c) => c.includes("remove"))).toBe(false);
        // The log surfaces the worktree path for manual cleanup.
        expect(logs.some((m) => m.includes("/wt/cg-5") && m.includes("gone"))).toBe(true);
    });

    it("reconcile ARCHIVED: an archived issue parks the run, drops the record, and leaves the worktree", async () => {
        const tracker = new WatchTracker({
            archived: { "CG-5": true },
            inReview: [],
            todo: [],
        });
        const { fs } = memRunsFs();
        const gitCalls: string[][] = [];
        const logs: string[] = [];
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-5",
                key: "CG-5",
                jobKind: "implement",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                git: async (cmd, args) => {
                    gitCalls.push([cmd, ...args]);
                    return { code: 0, stderr: "", stdout: "" };
                },
                log: (m) => {
                    logs.push(m);
                },
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "orphaned", key: "CG-5" });
        expect(seen).toHaveLength(0);
        expect(loadRecord("/runs", "CG-5", fs)).toBeNull();
        expect(gitCalls.some((c) => c.includes("remove"))).toBe(false);
        expect(logs.some((m) => m.includes("/wt/cg-5") && m.includes("archived"))).toBe(true);
    });

    it("reconcile TRANSIENT: a generic getIssue error rejects the tick and KEEPS the record", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            issueErrors: { "CG-5": new Error("plane: GET failed with 503") },
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-5",
                key: "CG-5",
                jobKind: "implement",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        let caught: unknown;
        try {
            await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        if (caught instanceof Error) {
            expect(caught.message).toMatch(/503/);
        }
        // The record is KEPT so the next tick retries it.
        expect(loadRecord("/runs", "CG-5", fs)).not.toBeNull();
    });

    it("returns at-capacity when In Progress is at the per-project cap (no resumable record)", async () => {
        const registryWithCap: Registry = {
            ...registry,
            projects: {
                CG: { ...registry.projects.CG!, limits: { inProgress: 1 } },
            },
        };
        // The In Progress item has no run-record, so the resume loop falls through
        // To the In Progress cap check rather than short-circuiting.
        const tracker = new WatchTracker({
            inProgress: [issue({ key: "CG-5" })],
            inReview: [],
            todo: [issue({ key: "CG-9" })],
        });
        const { fs } = memRunsFs();
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: registryWithCap, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("falls back to the built-in In Progress safety floor (3) when a project sets no limits", async () => {
        // No per-project limits; the In Progress floor is 3. Three In Progress
        // Items (none resumable) are at the floor, so dispatch is blocked.
        const tracker = new WatchTracker({
            inProgress: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" })],
            inReview: [],
            todo: [issue({ key: "CG-9" })],
        });
        const { fs } = memRunsFs();
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "at-capacity" });
        expect(seen).toHaveLength(0);
    });

    it("auto-Done: moves a merged In-Review item to Done and deletes its record", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, prMerged: async () => true, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "completed" });
        expect(tracker.calls.stateUpdates).toEqual([{ key: "CG-3", state: "Done" }]);
        expect(loadRecord("/runs", "CG-3", fs)).toBeNull();
        expect(seen).toHaveLength(0);
    });

    it("auto-Done: leaves an unmerged In-Review item in place", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, prMerged: async () => false, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(tracker.calls.stateUpdates).toHaveLength(0);
        expect(loadRecord("/runs", "CG-3", fs)).not.toBeNull();
    });

    it("rework: dispatches with a continuation and removes the label when feedback is present", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-3": [
                    {
                        body: "please rename the function",
                        createdAt: "2026-02-01T00:00:00.000Z",
                        id: "h1",
                        isBot: false,
                    },
                ],
            },
            inReview: [issue({ key: "CG-3", labels: ["changes-requested"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "rework", key: "CG-3" });
        expect(tracker.calls.removedLabels).toEqual([{ key: "CG-3", label: "changes-requested" }]);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toContain("please rename the function");
        // Agent-owned by default: keep telling the agent to manage the PR itself.
        expect(seen[0]!.task).toContain(AGENT_OWNED_MARKER);
        expect(seen[0]!.task).not.toContain(BEFLOW_OWNED_MARKER);
    });

    it("rework: a beflow-owned implement item gets the beflow-owned PR continuation", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-3": [
                    {
                        body: "please rename the function",
                        createdAt: "2026-02-01T00:00:00.000Z",
                        id: "h1",
                        isBot: false,
                    },
                ],
            },
            inReview: [issue({ key: "CG-3", labels: ["changes-requested"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: beflowOwnedRegistry(), runsFs: fs, tracker }));
        expect(out).toEqual({ action: "rework", key: "CG-3" });
        expect(seen).toHaveLength(1);
        // beflow owns the PR: the agent must NOT be told to open/update it via gh.
        expect(seen[0]!.task).toContain(BEFLOW_OWNED_MARKER);
        expect(seen[0]!.task).not.toContain(AGENT_OWNED_MARKER);
    });

    it("changes-requested without feedback: posts guidance once and does not dispatch", async () => {
        const tracker = new WatchTracker({
            comments: { "CG-3": [] },
            inReview: [issue({ key: "CG-3", labels: ["changes-requested"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out1 = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out1).toEqual({ action: "awaiting-feedback" });
        expect(tracker.calls.posted).toHaveLength(1);
        expect(seen).toHaveLength(0);

        // Second tick: the guidance is now the last bot comment, so it is not repeated.
        const out2 = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out2).toEqual({ action: "idle" });
        expect(tracker.calls.posted).toHaveLength(1);
    });

    it("answered: dispatches a Needs Input item with a continuation on a new human comment", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "use option B", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4" })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-4",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-4",
                status: "needs_input",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "answered", key: "CG-4" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toContain("use option B");
    });

    it("answered: strips stale blocked/failed labels before re-dispatching", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "go ahead", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: ["blocked", "failed"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-4",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-4",
                status: "blocked",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "answered", key: "CG-4" });
        expect(tracker.calls.removedLabels).toEqual([
            { key: "CG-4", label: "blocked" },
            { key: "CG-4", label: "failed" },
        ]);
        expect(seen).toHaveLength(1);
    });
});

describe("watchTick CI-red auto-rework", () => {
    function ciRecord(fs: RunStoreFs, over: Partial<Parameters<typeof saveRecord>[1]> = {}): void {
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
                ...over,
            },
            fs,
        );
    }

    it("re-dispatches rework on a red CI check with a new head SHA", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs);
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: ["build", "lint"], sha: "deadbeef", state: "failing" }),
                registry: ciRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "ci-rework", key: "CG-3" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toContain("The CI checks on this PR are failing (build, lint)");
        const rec = loadRecord("/runs", "CG-3", fs);
        expect(rec?.ciReworkSha).toBe("deadbeef");
        // CI-rework increments the universal counter (re-stamped after runIssue reset it).
        expect(rec?.attempts).toBe(1);
        // Agent-owned by default: the CI note tells the agent to update the existing PR.
        expect(seen[0]!.task).toContain("update the existing PR (https://github.com/x/y/pull/1)");
        expect(seen[0]!.task).toContain(AGENT_OWNED_MARKER);
    });

    it("beflow-owned CI-rework: the note says push the branch, not update the PR", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs);
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: ["build", "lint"], sha: "deadbeef", state: "failing" }),
                registry: beflowOwnedRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "ci-rework", key: "CG-3" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toContain("The CI checks on this PR are failing (build, lint)");
        // beflow owns the PR: the note must NOT tell the agent to update the PR via gh.
        expect(seen[0]!.task).not.toContain("update the existing PR");
        expect(seen[0]!.task).toContain("push your branch (beflow updates the PR)");
        expect(seen[0]!.task).toContain(BEFLOW_OWNED_MARKER);
        expect(seen[0]!.task).not.toContain(AGENT_OWNED_MARKER);
    });

    it("throttles: does NOT rework the same head SHA twice", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs, { attempts: 1, ciReworkSha: "deadbeef" });
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: ["build"], sha: "deadbeef", state: "failing" }),
                registry: ciRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        // No rework — the tick falls through to its normal idle outcome.
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("clears the failure streak when the PR goes green again", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs, { attempts: 2, ciReworkSha: "deadbeef" });
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: [], sha: "cafef00d", state: "passing" }),
                registry: ciRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
        expect(loadRecord("/runs", "CG-3", fs)?.attempts).toBe(0);
    });

    it("quarantines a perpetually-red PR once the universal counter hits the threshold", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs, { attempts: 3, ciReworkSha: "oldsha" });
        const { driver, seen } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                notify: notifier,
                prChecks: async () => ({ failing: ["build"], sha: "newsha", state: "failing" }),
                registry: ciRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "quarantined", key: "CG-3" });
        expect(seen).toHaveLength(0);
        expect(tracker.calls.stateUpdates).toEqual([{ key: "CG-3", state: "Needs Input" }]);
        expect(tracker.calls.addedLabels).toEqual([{ key: "CG-3", label: "quarantined" }]);
        // The reason is posted to the board (independent of any webhook).
        expect(tracker.calls.posted).toHaveLength(1);
        expect(tracker.calls.posted[0]!.body).toContain("CI red");
        expect(events.filter((e) => e.reason === "failed")).toHaveLength(1);
        const rec = loadRecord("/runs", "CG-3", fs);
        expect(rec?.status).toBe("failed");
        expect(rec?.heldReason).toBe("quarantine");
        // The loop-safety SHA is re-stamped so a re-check of the same head won't re-quarantine.
        expect(rec?.ciReworkSha).toBe("newsha");
    });

    it("is skipped entirely when autoReworkOnRed is not enabled", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        ciRecord(fs);
        let called = false;
        const { driver, seen } = fakeDriver();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => {
                    called = true;
                    return { failing: ["build"], sha: "deadbeef", state: "failing" };
                },
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(called).toBe(false);
        expect(seen).toHaveLength(0);
    });

    it("does no rework when checks are pending or absent", async () => {
        for (const state of ["pending", "none"] as const) {
            const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
            const { fs } = memRunsFs();
            ciRecord(fs);
            const { driver, seen } = fakeDriver();
            const out = await watchTick(
                "CG",
                deps({
                    driver,
                    prChecks: async () => ({ failing: [], sha: "deadbeef", state }),
                    registry: ciRegistry(true),
                    runsFs: fs,
                    tracker,
                }),
            );
            expect(out).toEqual({ action: "idle" });
            expect(seen).toHaveLength(0);
        }
    });
});

describe("watchTick cycle-aware scheduling", () => {
    it("dispatches an in-cycle Todo and skips the higher-priority out-of-cycle one", async () => {
        // CG-7 ranks first (urgent) but is NOT in the active cycle; CG-8 is. With
        // ActiveCycleOnly on, the filter narrows Todo to CG-8, which is dispatched.
        const tracker = new WatchTracker({
            cycleIds: new Set(["CG-8"]),
            inReview: [],
            todo: [issue({ key: "CG-7", priority: "urgent" }), issue({ key: "CG-8", priority: "low" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: cycleRegistry(true), tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-8" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.sessionKey).toBe("CG-8");
    });

    it("dispatches normally (no filter) when no active cycle is determinable (null)", async () => {
        const tracker = new WatchTracker({
            cycleIds: null,
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: cycleRegistry(true), tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        // No cycle filter ⇒ the whole batch (both Todos) dispatches within cap.
        expect(seen).toHaveLength(2);
    });

    it("goes idle when the active cycle has no Todo members (empty Set)", async () => {
        const tracker = new WatchTracker({
            cycleIds: new Set<string>(),
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                log: (m) => {
                    logs.push(m);
                },
                registry: cycleRegistry(true),
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
        expect(logs.some((l) => l.includes("active-cycle filter: 0/2"))).toBe(true);
    });

    it("ignores the cycle Set when activeCycleOnly is off (opt-in)", async () => {
        // The tracker reports a Set excluding CG-7, but the feature is off, so the
        // Top-priority CG-7 dispatches unfiltered.
        const tracker = new WatchTracker({
            cycleIds: new Set(["CG-8"]),
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: cycleRegistry(false), tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        // Feature off ⇒ no filter ⇒ both Todos dispatch unfiltered within cap.
        expect(seen).toHaveLength(2);
    });
});

describe("watchTick SLA re-escalation", () => {
    // The fixed clock (2026-06-14) sits far ahead of the records' updatedAt
    // (2026-01-01), so any positive threshold is comfortably exceeded.
    function needsInputRecord(fs: RunStoreFs, over: Partial<Parameters<typeof saveRecord>[1]> = {}): void {
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-4",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-4",
                status: "needs_input",
                updatedAt: "2026-01-01T00:00:00.000Z",
                ...over,
            },
            fs,
        );
    }

    it("fires a reminder and stamps escalatedAt for an aged Needs Input item (updatedAt unchanged)", async () => {
        const tracker = new WatchTracker({ inReview: [], needsInput: [issue({ key: "CG-4" })], todo: [] });
        const { fs } = memRunsFs();
        needsInputRecord(fs);
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        await watchTick(
            "CG",
            deps({ driver, notify: notifier, registry: slaRegistry({ needsInputMinutes: 60 }), runsFs: fs, tracker }),
        );
        const reminders = events.filter((e) => e.reason === "reminder");
        expect(reminders).toHaveLength(1);
        expect(reminders[0]!.key).toBe("CG-4");
        const rec = loadRecord("/runs", "CG-4", fs);
        expect(rec?.escalatedAt).toBe("2026-06-14T00:00:00.000Z");
        expect(rec?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("does NOT remind a fresh Needs Input record under the threshold", async () => {
        const tracker = new WatchTracker({ inReview: [], needsInput: [issue({ key: "CG-4" })], todo: [] });
        const { fs } = memRunsFs();
        // updatedAt only 30m before the clock; threshold is 60m.
        needsInputRecord(fs, { updatedAt: "2026-06-13T23:30:00.000Z" });
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        await watchTick(
            "CG",
            deps({ driver, notify: notifier, registry: slaRegistry({ needsInputMinutes: 60 }), runsFs: fs, tracker }),
        );
        expect(events.filter((e) => e.reason === "reminder")).toHaveLength(0);
        expect(loadRecord("/runs", "CG-4", fs)?.escalatedAt).toBeUndefined();
    });

    it("fires a reminder for an aged In Review item", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        await watchTick(
            "CG",
            deps({ driver, notify: notifier, registry: slaRegistry({ inReviewMinutes: 60 }), runsFs: fs, tracker }),
        );
        const reminders = events.filter((e) => e.reason === "reminder");
        expect(reminders).toHaveLength(1);
        expect(reminders[0]!.key).toBe("CG-3");
    });

    it("does no SLA work when no thresholds are configured", async () => {
        const tracker = new WatchTracker({
            inReview: [issue({ key: "CG-3" })],
            needsInput: [issue({ key: "CG-4" })],
            todo: [],
        });
        const { fs } = memRunsFs();
        needsInputRecord(fs);
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(events.filter((e) => e.reason === "reminder")).toHaveLength(0);
    });

    it("fires a resolved ping when an answered item had a prior escalation", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "go", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4" })],
            todo: [],
        });
        const { fs } = memRunsFs();
        needsInputRecord(fs, { escalatedAt: "2026-06-13T00:00:00.000Z" });
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "answered", key: "CG-4" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(1);
    });

    it("does NOT fire a resolved ping when an answered item had no prior escalation", async () => {
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "go", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4" })],
            todo: [],
        });
        const { fs } = memRunsFs();
        needsInputRecord(fs);
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "answered", key: "CG-4" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(0);
    });

    it("fires a resolved ping when a merged→Done item had a prior escalation", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                escalatedAt: "2026-06-13T00:00:00.000Z",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick(
            "CG",
            deps({ driver, notify: notifier, prMerged: async () => true, runsFs: fs, tracker }),
        );
        expect(out).toEqual({ action: "completed" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(1);
    });
});

describe("watchTick decision-gate release", () => {
    function decisionRecord(fs: RunStoreFs, over: Partial<Parameters<typeof saveRecord>[1]> = {}): void {
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                heldReason: "decision",
                jobKind: "implement",
                key: "CG-4",
                runMode: "autonomous",
                sessionName: "CG-4",
                status: "needs_input",
                updatedAt: "2026-01-01T00:00:00.000Z",
                ...over,
            },
            fs,
        );
    }

    it("releases a decision-hold back to Todo once the needs-decision label is removed", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        decisionRecord(fs);
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "released", key: "CG-4" });
        expect(tracker.calls.stateUpdates).toEqual([{ key: "CG-4", state: "Todo" }]);
        expect(loadRecord("/runs", "CG-4", fs)).toBeNull();
        // No agent dispatched on a release.
        expect(seen).toHaveLength(0);
    });

    it("does NOT release a decision-hold while the needs-decision label is still present", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: ["needs-decision"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        decisionRecord(fs);
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(tracker.calls.stateUpdates).toHaveLength(0);
        expect(loadRecord("/runs", "CG-4", fs)).not.toBeNull();
        expect(seen).toHaveLength(0);
    });

    it("does NOT re-dispatch via the answered loop while still needs-decision labeled (guard)", async () => {
        // A new human comment must NOT bypass an undecided hold: the answered loop skips
        // A still-labeled item, leaving it parked until the label is removed.
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "some thoughts", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: ["needs-decision"] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        decisionRecord(fs);
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
        expect(tracker.calls.stateUpdates).toHaveLength(0);
    });

    it("fires a resolved ping on release only when the record had escalatedAt", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        decisionRecord(fs, { escalatedAt: "2026-06-13T00:00:00.000Z" });
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "released", key: "CG-4" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(1);
    });

    it("does NOT fire a resolved ping on release when the record had no escalatedAt", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        decisionRecord(fs);
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "released", key: "CG-4" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(0);
    });

    it("ignores a non-decision Needs-Input record (no heldReason) in the release pass", async () => {
        // A plain Needs-Input record (no heldReason) with a new comment must still be
        // Re-dispatched by the answered loop, never touched by the release pass.
        const tracker = new WatchTracker({
            comments: {
                "CG-4": [{ body: "go ahead", createdAt: "2026-02-01T00:00:00.000Z", id: "h1", isBot: false }],
            },
            inReview: [],
            needsInput: [issue({ key: "CG-4", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/repo/bin",
                jobKind: "implement",
                key: "CG-4",
                runMode: "autonomous",
                sessionName: "CG-4",
                status: "needs_input",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "answered", key: "CG-4" });
        expect(seen).toHaveLength(1);
    });
});

describe("watch loop", () => {
    it("runs N ticks then stops, with an injected no-op sleep", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { driver } = fakeDriver();
        let ticks = 0;
        const sleeps: number[] = [];

        await watch("CG", deps({ driver, tracker }), {
            shouldStop: () => {
                ticks += 1;
                return ticks > 3;
            },
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            sleepMs: 30000,
        });

        // ShouldStop is consulted before each tick and after each tick: the loop
        // Runs a finite number of ticks and never sleeps after the final stop.
        expect(sleeps.length).toBeGreaterThan(0);
        expect(sleeps.every((ms) => ms === 30000)).toBe(true);
    });

    it("a transient tick error is caught, logged, and the loop continues to the next tick", async () => {
        // An in_progress autonomous record whose getIssue throws a generic error
        // Makes watchTick reject; the per-tick guard in watch() must catch it,
        // Log it, and keep looping rather than crash the daemon.
        const tracker = new WatchTracker({
            inReview: [],
            issueErrors: { "CG-5": new Error("plane: GET failed with 503") },
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-5",
                key: "CG-5",
                jobKind: "implement",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const logs: string[] = [];
        let consulted = 0;
        const sleeps: number[] = [];

        const log = (m: string): void => {
            logs.push(m);
        };
        await watch("CG", deps({ driver, log, runsFs: fs, tracker }), {
            shouldStop: () => {
                // Consulted before AND after each tick. Allow exactly two ticks.
                consulted += 1;
                return consulted > 4;
            },
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            sleepMs: 30000,
        });

        // The daemon did not throw out of watch(); it ran multiple ticks and slept
        // Between them, logging each caught tick error.
        const tickErrors = logs.filter((m) => m.includes("tick errored") && m.includes("503"));
        expect(tickErrors.length).toBeGreaterThanOrEqual(2);
        expect(sleeps.length).toBeGreaterThanOrEqual(1);
        // The record is never destroyed by a transient failure.
        expect(loadRecord("/runs", "CG-5", fs)).not.toBeNull();
    });
});

describe("watchTick unified quarantine", () => {
    it("a CI-rework failure increments the SAME counter the crash-resume path reads", async () => {
        // The two failure paths share `record.attempts`. A CI-rework that just missed the
        // Threshold bumps it to the threshold; the crash-resume pass on the SAME record then
        // Quarantines — proving the counter accumulates across both paths.
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 2,
                cwd: "/repo/bin",
                key: "CG-3",
                jobKind: "implement",
                prUrl: "https://github.com/x/y/pull/1",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();

        // CI-rework on a red, fresh SHA: counter 2 → 3 (re-stamped after runIssue reset it).
        const out1 = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: ["build"], sha: "shaA", state: "failing" }),
                registry: ciRegistry(true),
                runsFs: fs,
                tracker,
            }),
        );
        expect(out1).toEqual({ action: "ci-rework", key: "CG-3" });
        expect(loadRecord("/runs", "CG-3", fs)?.attempts).toBe(3);
        expect(seen).toHaveLength(1);

        // Force the (now `done`) record back to in_progress to mimic a crashed run resuming,
        // Preserving the shared counter the CI path advanced. The crash-resume pass reads the
        // Same `attempts` and quarantines at the threshold — no second agent dispatch.
        const after = loadRecord("/runs", "CG-3", fs)!;
        saveRecord("/runs", { ...after, status: "in_progress" }, fs);
        const out2 = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out2).toEqual({ action: "quarantined", key: "CG-3" });
        expect(seen).toHaveLength(1);
        expect(tracker.calls.addedLabels).toContainEqual({ key: "CG-3", label: "quarantined" });
        expect(loadRecord("/runs", "CG-3", fs)?.heldReason).toBe("quarantine");
    });

    it("respects a per-project deadLetter.maxAttempts override", async () => {
        const dlRegistry: Registry = {
            ...registry,
            projects: { CG: { ...registry.projects.CG!, deadLetter: { maxAttempts: 1 } } },
        };
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 1,
                cwd: "/repo/bin",
                key: "CG-5",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-5",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: dlRegistry, runsFs: fs, tracker }));
        // Threshold lowered to 1, so a single prior attempt already quarantines.
        expect(out).toEqual({ action: "quarantined", key: "CG-5" });
        expect(seen).toHaveLength(0);
    });

    it("dispatch skips a quarantined Todo item", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7", labels: [QUARANTINED_LABEL] }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        // The quarantined item is skipped; the next clean Todo is dispatched instead.
        expect(out).toEqual({ action: "dispatched", key: "CG-8" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toBeDefined();
    });

    it("idles when the only Todo is quarantined", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7", labels: [QUARANTINED_LABEL] })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("release: clears the hold and returns to Todo once the quarantined label is removed", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-9", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 3,
                cwd: "/repo/bin",
                heldReason: "quarantine",
                jobKind: "implement",
                key: "CG-9",
                runMode: "autonomous",
                sessionName: "CG-9",
                status: "failed",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "released", key: "CG-9" });
        expect(tracker.calls.stateUpdates).toEqual([{ key: "CG-9", state: "Todo" }]);
        // The record is RESET (not deleted): counter cleared, hold cleared.
        const rec = loadRecord("/runs", "CG-9", fs);
        expect(rec).not.toBeNull();
        expect(rec?.attempts).toBe(0);
        expect(rec?.heldReason).toBeUndefined();
        expect(seen).toHaveLength(0);
    });

    it("does NOT release a quarantine hold while the quarantined label is still present", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-9", labels: [QUARANTINED_LABEL] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 3,
                cwd: "/repo/bin",
                heldReason: "quarantine",
                jobKind: "implement",
                key: "CG-9",
                runMode: "autonomous",
                sessionName: "CG-9",
                status: "failed",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(tracker.calls.stateUpdates).toHaveLength(0);
        expect(loadRecord("/runs", "CG-9", fs)?.heldReason).toBe("quarantine");
        expect(seen).toHaveLength(0);
    });

    it("fires a resolved ping on release only when the record had escalatedAt", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            needsInput: [issue({ key: "CG-9", labels: [] })],
            todo: [],
        });
        const { fs } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 3,
                cwd: "/repo/bin",
                escalatedAt: "2026-06-13T00:00:00.000Z",
                heldReason: "quarantine",
                jobKind: "implement",
                key: "CG-9",
                runMode: "autonomous",
                sessionName: "CG-9",
                status: "failed",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver();
        const { events, notifier } = spyNotifier();
        const out = await watchTick("CG", deps({ driver, notify: notifier, runsFs: fs, tracker }));
        expect(out).toEqual({ action: "released", key: "CG-9" });
        expect(events.filter((e) => e.reason === "resolved")).toHaveLength(1);
    });
});

describe("watchTick concurrent Todo dispatch", () => {
    function capRegistry(inProgress: number): Registry {
        return {
            ...registry,
            projects: { CG: { ...registry.projects.CG!, limits: { inProgress } } },
        };
    }

    // A driver that throws only for the given session keys; all others succeed.
    function selectiveDriver(throwFor: Set<string>): { driver: AgentDriver; seen: RunOptions[] } {
        const seen: RunOptions[] = [];
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (opts: RunOptions): Promise<AgentRunResult> => {
                seen.push(opts);
                if (throwFor.has(opts.sessionKey)) {
                    throw new Error(`agent exploded for ${opts.sessionKey}`);
                }
                return {
                    exitCode: 0,
                    raw: [],
                    report: { status: "done", summary: "s" },
                    stream: { assistantText: "", toolCalls: [] },
                    timedOut: false,
                };
            },
        };
        return { driver, seen };
    }

    it("dispatches N = remaining cap when there are at least N eligible Todos", async () => {
        // Cap 3, nothing in progress ⇒ 3 slots; 4 eligible Todos ⇒ exactly 3 dispatch.
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" }), issue({ key: "CG-4" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: capRegistry(3), tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-1" });
        expect(seen).toHaveLength(3);
        expect(seen.map((s) => s.sessionKey).sort()).toEqual(["CG-1", "CG-2", "CG-3"]);
    });

    it("never exceeds the cap: dispatches only cap - inProgress items", async () => {
        // Cap 3 with two already in progress (no resumable records) ⇒ 1 free slot.
        const tracker = new WatchTracker({
            inProgress: [issue({ key: "CG-5" }), issue({ key: "CG-6" })],
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" })],
        });
        const { fs } = memRunsFs();
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: capRegistry(3), runsFs: fs, tracker }));
        expect(out).toEqual({ action: "dispatched", key: "CG-1" });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.sessionKey).toBe("CG-1");
    });

    it("skips blocked, quarantined, and out-of-cycle candidates while filling slots", async () => {
        // Cap 3 ⇒ 3 slots. CG-1 blocked, CG-2 quarantined, CG-9 out of cycle; the
        // Eligible in-cycle, unblocked, clean items are CG-3 and CG-4.
        const tracker = new WatchTracker({
            blockers: { "CG-1": [{ done: false, key: "CG-0" }] },
            cycleIds: new Set(["CG-1", "CG-2", "CG-3", "CG-4"]),
            inReview: [],
            todo: [
                issue({ key: "CG-1" }),
                issue({ key: "CG-2", labels: [QUARANTINED_LABEL] }),
                issue({ key: "CG-3" }),
                issue({ key: "CG-4" }),
                issue({ key: "CG-9" }),
            ],
        });
        const cycleCap: Registry = {
            ...registry,
            projects: {
                CG: {
                    ...registry.projects.CG!,
                    limits: { inProgress: 3 },
                    scheduling: { activeCycleOnly: true },
                },
            },
        };
        const { driver, seen } = fakeDriver();
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                log: (m) => {
                    logs.push(m);
                },
                registry: cycleCap,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "dispatched", key: "CG-3" });
        expect(seen.map((s) => s.sessionKey).sort()).toEqual(["CG-3", "CG-4"]);
        expect(logs.some((l) => l.includes("CG-1 skipped: blocked-by CG-0 (not done)"))).toBe(true);
        expect(logs.some((l) => l.includes("CG-2 skipped: quarantined"))).toBe(true);
    });

    it("one item throwing does not block the others; the rest still dispatch", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" })],
        });
        const { driver, seen } = selectiveDriver(new Set(["CG-1"]));
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                log: (m) => {
                    logs.push(m);
                },
                registry: capRegistry(3),
                tracker,
            }),
        );
        // CG-1 threw, but CG-2 and CG-3 still dispatched; action stays dispatched
        // With the first SUCCESSFULLY dispatched key as representative.
        expect(out).toEqual({ action: "dispatched", key: "CG-2" });
        expect(seen).toHaveLength(3);
        expect(logs.some((l) => l.includes("dispatch CG-1 errored"))).toBe(true);
    });

    it("returns idle when no Todo is eligible", async () => {
        const tracker = new WatchTracker({
            blockers: { "CG-1": [{ done: false, key: "CG-0" }] },
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2", labels: [QUARANTINED_LABEL] })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", deps({ driver, registry: capRegistry(3), tracker }));
        expect(out).toEqual({ action: "idle" });
        expect(seen).toHaveLength(0);
    });

    it("returns error when every collected item errors", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2" })],
        });
        const { driver, seen } = selectiveDriver(new Set(["CG-1", "CG-2"]));
        const out = await watchTick("CG", deps({ driver, registry: capRegistry(3), tracker }));
        expect(out).toEqual({ action: "error", key: "CG-1" });
        expect(seen).toHaveLength(2);
    });

    it("forces autonomous dispatch even when the project default is supervised (so each run gets an isolated worktree)", async () => {
        // Regression: watch was passing `{}` as the cli arg, so a project whose
        // configured default runMode is "supervised" would dispatch supervised runs,
        // skipping worktree isolation and causing concurrent agents to race in the
        // shared repo root. watch must ALWAYS force autonomous regardless of config.
        const supervisedConfig: Config = {
            ...config,
            runMode: "supervised",
        };
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-7" }), issue({ key: "CG-8" })],
        });
        const { driver, seen } = fakeDriver();
        const out = await watchTick("CG", { ...deps({ driver, tracker }), config: supervisedConfig });
        expect(out).toEqual({ action: "dispatched", key: "CG-7" });
        expect(seen).toHaveLength(2);
        expect(seen.every((s) => s.runMode === "autonomous")).toBe(true);
    });

    it("dry-run previews the batch it would dispatch and mutates nothing", async () => {
        const tracker = new WatchTracker({
            inReview: [],
            todo: [issue({ key: "CG-1" }), issue({ key: "CG-2" }), issue({ key: "CG-3" })],
        });
        const { fs } = memRunsFs();
        const { driver, seen } = fakeDriver();
        const logs: string[] = [];
        const out = await watchTick(
            "CG",
            deps({
                driver,
                dryRun: true,
                log: (m) => {
                    logs.push(m);
                },
                registry: capRegistry(2),
                runsFs: fs,
                tracker,
            }),
        );
        // Cap 2 ⇒ 2 slots: the preview names both keys it would dispatch.
        expect(out).toEqual({ action: "dispatched", key: "CG-1" });
        expect(logs.some((l) => l.includes("DRY RUN: would dispatch CG-1, CG-2"))).toBe(true);
        // No agent ran and nothing was written or mutated.
        expect(seen).toHaveLength(0);
        expect(tracker.calls.stateUpdates).toHaveLength(0);
        expect(tracker.calls.posted).toHaveLength(0);
        expect([...fs.list("/runs")]).toHaveLength(0);
    });
});

describe("watchTick PR review pass", () => {
    function reviewRegistry(enabled: boolean): Registry {
        return {
            ...registry,
            projects: { CG: { ...registry.projects.CG!, review: { enabled } } },
        };
    }

    function reviewRecord(fs: RunStoreFs, over: Record<string, unknown> = {}): void {
        saveRecord(
            "/runs",
            {
                agent: "claude",
                cwd: "/wt/cg-3",
                jobKind: "implement",
                key: "CG-3",
                prUrl: "https://github.com/x/y/pull/1",
                repoPath: "/repo/bin",
                runMode: "autonomous",
                sessionName: "CG-3",
                status: "done",
                updatedAt: "2026-01-01T00:00:00.000Z",
                ...over,
            },
            fs,
        );
    }

    function spyReview(): { calls: string[]; runReview: (key: string, d: RunReviewDeps) => Promise<unknown> } {
        const calls: string[] = [];
        return {
            calls,
            runReview: async (key) => {
                calls.push(key);
                return { findings: 1, reviewed: true };
            },
        };
    }

    it("reviews an In-Review PR whose head SHA differs from reviewedSha", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        reviewRecord(fs, { reviewedSha: "oldsha" });
        const { driver } = fakeDriver();
        const { calls, runReview } = spyReview();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: [], sha: "newsha", state: "passing" }),
                registry: reviewRegistry(true),
                runReview,
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "reviewed", key: "CG-3" });
        expect(calls).toEqual(["CG-3"]);
    });

    it("skips when the head SHA matches reviewedSha (already reviewed)", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        reviewRecord(fs, { reviewedSha: "samesha" });
        const { driver } = fakeDriver();
        const { calls, runReview } = spyReview();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: [], sha: "samesha", state: "passing" }),
                registry: reviewRegistry(true),
                runReview,
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(calls).toHaveLength(0);
    });

    it("is gated off when review.enabled is not set", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const { driver } = fakeDriver();
        const { calls, runReview } = spyReview();
        const out = await watchTick(
            "CG",
            deps({
                driver,
                prChecks: async () => ({ failing: [], sha: "newsha", state: "passing" }),
                runReview,
                runsFs: fs,
                tracker,
            }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(calls).toHaveLength(0);
    });

    it("is skipped when prChecks (the head-SHA source) is absent", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const { driver } = fakeDriver();
        const { calls, runReview } = spyReview();
        const out = await watchTick(
            "CG",
            deps({ driver, registry: reviewRegistry(true), runReview, runsFs: fs, tracker }),
        );
        expect(out).toEqual({ action: "idle" });
        expect(calls).toHaveLength(0);
    });

    it("is skipped under --dry-run (never dispatches a review)", async () => {
        const tracker = new WatchTracker({ inReview: [issue({ key: "CG-3" })], todo: [] });
        const { fs } = memRunsFs();
        reviewRecord(fs, { reviewedSha: "oldsha" });
        const { driver } = fakeDriver();
        const { calls, runReview } = spyReview();
        let checksCalled = false;
        await watchTick(
            "CG",
            deps({
                driver,
                dryRun: true,
                prChecks: async () => {
                    checksCalled = true;
                    return { failing: [], sha: "newsha", state: "passing" };
                },
                registry: reviewRegistry(true),
                runReview,
                runsFs: fs,
                tracker,
            }),
        );
        expect(calls).toHaveLength(0);
        expect(checksCalled).toBe(false);
    });
});
