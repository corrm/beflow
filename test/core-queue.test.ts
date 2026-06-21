import { describe, expect, it } from "bun:test";

import type { Registry } from "../src/config/schema.ts";
import { queueView } from "../src/core/queue.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    Comment,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ProjectCreateResult,
    QueueFilter,
    Tracker,
} from "../src/trackers/tracker.ts";

const registry: Registry = {
    projects: {
        CG: {
            default_repo: "bin",
            module_repo_map: {},
            name: "My App",
            plane_project_id: "p1",
            repos: { bin: "/repo/bin" },
            root: "/r1",
        },
        LP: {
            default_repo: "lp",
            module_repo_map: {},
            name: "Codegen",
            plane_project_id: "p2",
            repos: { lp: "/repo/lp" },
            root: "/r2",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

function issue(over: Partial<Issue> & { key: string; title: string }): Issue {
    return {
        areas: [],
        body: "",
        id: over.key,
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        type: "Bug",
        ...over,
    };
}

class QueueTracker implements Tracker {
    filters: QueueFilter[] = [];
    constructor(private readonly byProject: Record<string, Issue[]>) {}
    async getIssue(): Promise<Issue> {
        throw new Error("unused");
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async createIssue(_project: string, draft: IssueDraft): Promise<Issue> {
        return issue({ key: "CG-NEW", title: draft.title });
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(f: QueueFilter): Promise<Issue[]> {
        this.filters.push(f);
        return this.byProject[f.project] ?? [];
    }
    async updateState(): Promise<void> {}
    async assign(): Promise<void> {}
    async addProperty(): Promise<void> {}
    async removeProperty(): Promise<void> {}
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(): Promise<void> {}
    async listComments(): Promise<Comment[]> {
        return [];
    }
    async linkPR(): Promise<void> {}
    readMetadata(): IssueMeta {
        return {};
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return { labels: [], modules: [], states: [], types: [] };
    }
    async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
    async verifyAuth(): Promise<void> {}
}

describe("queueView", () => {
    it("merges rows in registry project order, preserving per-project rank", async () => {
        const tracker = new QueueTracker({
            CG: [
                issue({ key: "CG-1", priority: "urgent", title: "urgent" }),
                issue({ key: "CG-2", priority: "high", title: "high" }),
            ],
            LP: [issue({ key: "LP-9", priority: "high", title: "lp top" })],
        });
        const rows = await queueView({ registry, tracker }, {});
        expect(rows.map((r) => r.key)).toEqual(["CG-1", "CG-2", "LP-9"]);
        expect(rows[0]).toMatchObject({
            priority: "urgent",
            project: "CG",
            state: "Todo",
        });
    });

    it("passes the state filter through to listQueue", async () => {
        const tracker = new QueueTracker({ CG: [], LP: [] });
        await queueView({ registry, tracker }, { state: "In Review" });
        expect(tracker.filters.every((f) => f.state === "In Review")).toBe(true);
    });

    it("restricts to the given projects", async () => {
        const tracker = new QueueTracker({
            CG: [issue({ key: "CG-1", title: "a" })],
            LP: [issue({ key: "LP-1", title: "b" })],
        });
        const rows = await queueView({ registry, tracker }, { projects: ["LP"] });
        expect(rows.map((r) => r.key)).toEqual(["LP-1"]);
    });

    it("handles an empty queue", async () => {
        const tracker = new QueueTracker({ CG: [], LP: [] });
        const rows = await queueView({ registry, tracker }, {});
        expect(rows).toEqual([]);
    });
});
