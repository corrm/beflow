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
    async findProjectId(): Promise<string | null> {
        return null;
    }
}

class FlakyQueueTracker extends QueueTracker {
    constructor(
        byProject: Record<string, Issue[]>,
        private readonly failProjects: Set<string>,
    ) {
        super(byProject);
    }
    override async listQueue(f: QueueFilter): Promise<Issue[]> {
        if (this.failProjects.has(f.project)) {
            throw new Error(`tracker exploded for ${f.project}`);
        }
        return super.listQueue(f);
    }
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
        const { rows, errors } = await queueView({ registry, tracker }, {});
        expect(rows.map((r) => r.key)).toEqual(["CG-1", "CG-2", "LP-9"]);
        expect(errors).toEqual([]);
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
        const { rows } = await queueView({ registry, tracker }, { projects: ["LP"] });
        expect(rows.map((r) => r.key)).toEqual(["LP-1"]);
    });

    it("handles an empty queue", async () => {
        const tracker = new QueueTracker({ CG: [], LP: [] });
        const { rows, errors } = await queueView({ registry, tracker }, {});
        expect(rows).toEqual([]);
        expect(errors).toEqual([]);
    });

    it("collects a per-project error and keeps the other project's rows", async () => {
        const tracker = new FlakyQueueTracker(
            { CG: [issue({ key: "CG-1", title: "a" })], LP: [issue({ key: "LP-1", title: "b" })] },
            new Set(["CG"]),
        );
        const { rows, errors } = await queueView({ registry, tracker }, {});
        expect(rows.map((r) => r.key)).toEqual(["LP-1"]);
        expect(errors).toEqual([{ message: "tracker exploded for CG", project: "CG" }]);
    });

    it("rejects an unknown project before any tracker call", async () => {
        const tracker = new QueueTracker({ CG: [], LP: [] });
        expect(queueView({ registry, tracker }, { projects: ["ZZ"] })).rejects.toThrow(
            /unknown project "ZZ" \(known: .*\)/,
        );
        expect(tracker.filters).toHaveLength(0);
    });
});
