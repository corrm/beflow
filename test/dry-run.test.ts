import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import { runCli } from "../src/cli.ts";
import type { CliDeps } from "../src/cli.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    BoardTemplate,
    Comment,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ProjectCreateResult,
    QueueFilter,
    Tracker,
} from "../src/trackers/tracker.ts";

const config: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    runs: { dir: join(tmpdir(), "beflow-dry-run-test-runs") },
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

function makeIssue(over: Partial<Issue> & { key: string }): Issue {
    return {
        areas: [],
        body: "a reasonably detailed body that easily clears any thin-issue floor",
        id: over.key,
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "Crash",
        type: "Bug",
        ...over,
    };
}

interface Mutations {
    addedLabels: string[];
    assigned: number;
    comments: string[];
    linkedPRs: number;
    removedLabels: string[];
    stateUpdates: string[];
}

class FakeTracker implements Tracker {
    readonly mutations: Mutations = {
        addedLabels: [],
        assigned: 0,
        comments: [],
        linkedPRs: 0,
        removedLabels: [],
        stateUpdates: [],
    };
    constructor(private readonly queues: { inReview?: Issue[]; todo?: Issue[]; inProgress?: Issue[] } = {}) {}
    async getIssue(key: string): Promise<Issue> {
        return makeIssue({ key });
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async createIssue(_project: string, draft: IssueDraft): Promise<Issue> {
        return makeIssue({ key: "CG-NEW", title: draft.title });
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(f: QueueFilter): Promise<Issue[]> {
        if (f.state === "In Review") {
            return this.queues.inReview ?? [];
        }
        if (f.state === "Todo") {
            return this.queues.todo ?? [];
        }
        if (f.state === "In Progress") {
            return this.queues.inProgress ?? [];
        }
        return [];
    }
    async updateState(_issue: Issue, stateName: string): Promise<void> {
        this.mutations.stateUpdates.push(stateName);
    }
    async assign(): Promise<void> {
        this.mutations.assigned += 1;
    }
    async addProperty(_issue: Issue, name: string): Promise<void> {
        this.mutations.addedLabels.push(name);
    }
    async removeProperty(_issue: Issue, name: string): Promise<void> {
        this.mutations.removedLabels.push(name);
    }
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(_issue: Issue, body: string): Promise<void> {
        this.mutations.comments.push(body);
    }
    async listComments(): Promise<Comment[]> {
        return [];
    }
    async linkPR(): Promise<void> {
        this.mutations.linkedPRs += 1;
    }
    readMetadata(): IssueMeta {
        return {};
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return {
            labels: ["blocked", "quarantined", "triaged"],
            modules: [],
            states: ["Backlog", "Todo", "In Progress", "Needs Input", "In Review", "Done"],
            types: [],
        };
    }
    async ensureBoard(_project: string, _template: BoardTemplate): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
    async verifyAuth(): Promise<void> {}
    async findProjectId(): Promise<string | null> {
        return null;
    }
}

function noMutations(t: FakeTracker): boolean {
    const m = t.mutations;
    return (
        m.stateUpdates.length === 0 &&
        m.assigned === 0 &&
        m.addedLabels.length === 0 &&
        m.removedLabels.length === 0 &&
        m.comments.length === 0 &&
        m.linkedPRs === 0
    );
}

interface Harness {
    deps: CliDeps;
    driverRuns: RunOptions[];
    logs: string[];
}

function harness(tracker: Tracker): Harness {
    const driverRuns: RunOptions[] = [];
    const logs: string[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            driverRuns.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report: { status: "done", summary: "s" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };
    const deps: CliDeps = {
        createDriver: () => driver,
        createTracker: () => tracker,
        cwd: "/cwd",
        loadConfig: () => config,
        loadRegistry: () => registry,
        log: (m) => {
            logs.push(m);
        },
        // A looping runner that, if reached, would throw — proving dry-run watch
        // Never falls through to the live watch loop.
        watch: async () => {
            throw new Error("live watch loop must not run under --dry-run");
        },
    };
    return { deps, driverRuns, logs };
}

describe("run --dry-run", () => {
    it("previews the plan with zero side effects and never dispatches", async () => {
        const tracker = new FakeTracker();
        const { deps, driverRuns, logs } = harness(tracker);
        const code = await runCli(["run", "CG-42", "--auto", "--dry-run"], deps);
        expect(code).toBe(0);
        expect(driverRuns).toHaveLength(0);
        expect(noMutations(tracker)).toBe(true);
        const out = logs.join("\n");
        expect(out).toContain("DRY RUN");
        expect(out).toContain("claude");
        expect(out).toContain("implement");
    });
});

describe("watch --dry-run", () => {
    it("runs one read-only tick, logs a dispatch decision, and mutates nothing", async () => {
        const tracker = new FakeTracker({ inReview: [], todo: [makeIssue({ key: "CG-7" })] });
        const { deps, driverRuns, logs } = harness(tracker);
        const code = await runCli(["watch", "CG", "--dry-run"], deps);
        expect(code).toBe(0);
        expect(driverRuns).toHaveLength(0);
        expect(noMutations(tracker)).toBe(true);
        expect(logs.some((l) => l.includes("DRY RUN") && l.includes("would dispatch CG-7"))).toBe(true);
    });

    it("logs an idle decision when Todo is empty, mutating nothing", async () => {
        const tracker = new FakeTracker({ inReview: [], todo: [] });
        const { deps, driverRuns, logs } = harness(tracker);
        const code = await runCli(["watch", "CG", "--dry-run"], deps);
        expect(code).toBe(0);
        expect(driverRuns).toHaveLength(0);
        expect(noMutations(tracker)).toBe(true);
        expect(logs.some((l) => l.includes("DRY RUN") && l.includes("would idle"))).toBe(true);
    });
});

describe("--dry-run flag parsing", () => {
    it("is recognized by run (does not error as an unknown flag)", async () => {
        const tracker = new FakeTracker();
        const { deps } = harness(tracker);
        const code = await runCli(["run", "CG-42", "--dry-run"], deps);
        expect(code).toBe(0);
    });

    it("is recognized by watch (does not error as an unknown flag)", async () => {
        const tracker = new FakeTracker({ inReview: [], todo: [] });
        const { deps } = harness(tracker);
        const code = await runCli(["watch", "CG", "--dry-run"], deps);
        expect(code).toBe(0);
    });
});
