import { describe, expect, it } from "bun:test";

import { REQUIRED_LABELS, REQUIRED_STATES, assertBoardReady, boardDrift } from "../src/core/drift.ts";
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

const template: BoardTemplate = {
    labels: [{ name: "blocked" }, { name: "triaged" }],
    modules: [{ name: "GUI" }, { name: "Website" }],
    states: [
        { name: "Backlog", color: "#000", group: "backlog" },
        { name: "Todo", color: "#000", group: "unstarted" },
        { name: "In Progress", color: "#000", group: "started" },
        { name: "Needs Input", color: "#000", group: "started" },
        { name: "In Review", color: "#000", group: "started" },
        { name: "Done", color: "#000", group: "completed" },
    ],
    types: [{ name: "Bug" }],
};

function healthyBoard(): BoardState {
    return {
        labels: [...REQUIRED_LABELS],
        modules: ["GUI", "Website"],
        states: [...REQUIRED_STATES],
        types: ["Bug"],
    };
}

class FakeTracker implements Tracker {
    constructor(
        private readonly board: BoardState | Error,
        public readonly logs: string[] = [],
    ) {}
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
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(_project: string): Promise<BoardState> {
        if (this.board instanceof Error) {
            return Promise.reject(this.board);
        }
        return Promise.resolve(this.board);
    }
    async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
}

function asTracker(t: FakeTracker): Tracker {
    return t;
}

describe("boardDrift", () => {
    it("reports nothing when the board matches the template", () => {
        const d = boardDrift(template, healthyBoard());
        expect(d.missingStates).toEqual([]);
        expect(d.missingLabels).toEqual([]);
        expect(d.missingModules).toEqual([]);
        expect(d.extraStates).toEqual([]);
    });

    it("detects missing states, labels, and modules", () => {
        const board: BoardState = {
            labels: ["blocked"],
            modules: ["GUI"],
            states: ["Backlog", "Todo", "In Progress", "Needs Input", "Done"],
            types: [],
        };
        const d = boardDrift(template, board);
        expect(d.missingStates).toEqual(["In Review"]);
        expect(d.missingLabels).toEqual(["triaged"]);
        expect(d.missingModules).toEqual(["Website"]);
    });

    it("detects extra (renamed) states present on the board", () => {
        const board = healthyBoard();
        board.states.push("Reviewing");
        const d = boardDrift(template, board);
        expect(d.extraStates).toEqual(["Reviewing"]);
    });
});

describe("assertBoardReady", () => {
    it("passes when all required states and labels are present", async () => {
        const tracker = new FakeTracker(healthyBoard());
        expect(assertBoardReady("CG", asTracker(tracker))).resolves.toBeUndefined();
    });

    it("throws an actionable error when a required state is missing", async () => {
        const board = healthyBoard();
        board.states = board.states.filter((s) => s !== "In Review");
        const tracker = new FakeTracker(board);
        let message = "";
        try {
            await assertBoardReady("CG", asTracker(tracker));
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain("In Review");
        expect(message).toContain("beflow update CG");
    });

    it("throws when a required label is missing", async () => {
        const board = healthyBoard();
        board.labels = board.labels.filter((l) => l !== "blocked");
        const tracker = new FakeTracker(board);
        let message = "";
        try {
            await assertBoardReady("CG", asTracker(tracker));
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain("blocked");
        expect(message).toContain("beflow update CG");
    });

    it("throws when the quarantined label is missing", async () => {
        const board = healthyBoard();
        board.labels = board.labels.filter((l) => l !== "quarantined");
        const tracker = new FakeTracker(board);
        let message = "";
        try {
            await assertBoardReady("CG", asTracker(tracker));
        } catch (err) {
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).toContain("quarantined");
        expect(message).toContain("beflow update CG");
    });

    it("swallows an inspect failure and logs, instead of throwing", async () => {
        const logs: string[] = [];
        const tracker = new FakeTracker(new Error("network down"));
        expect(
            assertBoardReady("CG", asTracker(tracker), (m) => {
                logs.push(m);
            }),
        ).resolves.toBeUndefined();
        expect(logs.some((l) => l.includes("could not verify board"))).toBe(true);
        expect(logs.some((l) => l.includes("network down"))).toBe(true);
    });
});
