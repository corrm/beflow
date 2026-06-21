import { describe, expect, it } from "bun:test";

import { acceptIntake } from "../src/core/accept.ts";
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

function intake(id: string, title = "item"): IntakeItem {
    return { body: "", id, issueId: `wi-${id}`, status: 0, title };
}

class InboxTracker implements Tracker {
    accepted: { project: string; item: IntakeItem }[] = [];
    constructor(private readonly inbox: IntakeItem[]) {}
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
        return {
            areas: [],
            body: draft.body,
            id: "wi-new",
            key: "CG-NEW",
            labels: draft.labels ?? [],
            meta: {},
            priority: draft.priority,
            state: { group: "unstarted", name: draft.state ?? "Todo" },
            title: draft.title,
            type: draft.type,
        };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(_f: QueueFilter): Promise<Issue[]> {
        return [];
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
        return this.inbox;
    }
    async acceptInbox(project: string, item: IntakeItem): Promise<void> {
        this.accepted.push({ item, project });
    }
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

describe("acceptIntake", () => {
    it("accepts the matching intake item and returns it", async () => {
        const tracker = new InboxTracker([intake("i1"), intake("i2", "second")]);
        const item = await acceptIntake("CG", "i2", { tracker });
        expect(item.id).toBe("i2");
        expect(tracker.accepted).toHaveLength(1);
        expect(tracker.accepted[0]).toMatchObject({
            item: { id: "i2" },
            project: "CG",
        });
    });

    it("throws on an unknown id, listing available ids", async () => {
        const tracker = new InboxTracker([intake("i1"), intake("i2")]);
        expect(acceptIntake("CG", "zzz", { tracker })).rejects.toThrow(/unknown intake id "zzz".*available: i1, i2/);
        expect(tracker.accepted).toHaveLength(0);
    });
});
