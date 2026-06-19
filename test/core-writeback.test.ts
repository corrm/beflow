import { describe, expect, it } from "bun:test";

import type { Report } from "../src/agent/report.ts";
import { applyReport, defaultDoneState } from "../src/core/writeback.ts";
import type { Issue, IssueMeta, JobKind } from "../src/model/types.ts";
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

type Call =
    | { kind: "updateState"; state: string }
    | { kind: "assign"; assignee: string }
    | { kind: "addProperty"; label: string }
    | { kind: "removeProperty"; label: string }
    | { kind: "comment"; body: string }
    | { kind: "linkPR"; url: string };

class FakeTracker implements Tracker {
    calls: Call[] = [];

    async getIssue(): Promise<Issue> {
        throw new Error("not used");
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
    async updateState(_issue: Issue, stateName: string): Promise<void> {
        this.calls.push({ kind: "updateState", state: stateName });
    }
    async assign(_issue: Issue, assigneeId: string): Promise<void> {
        this.calls.push({ assignee: assigneeId, kind: "assign" });
    }
    async addProperty(_issue: Issue, name: string): Promise<void> {
        this.calls.push({ kind: "addProperty", label: name });
    }
    async removeProperty(_issue: Issue, name: string): Promise<void> {
        this.calls.push({ kind: "removeProperty", label: name });
    }
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(_issue: Issue, body: string): Promise<void> {
        this.calls.push({ body, kind: "comment" });
    }
    async listComments(): Promise<Comment[]> {
        return [];
    }
    async linkPR(_issue: Issue, url: string): Promise<void> {
        this.calls.push({ kind: "linkPR", url });
    }
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
    async ensureBoard(_p: string, _t: BoardTemplate): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
}

function issue(): Issue {
    return {
        areas: [],
        body: "",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: {},
        state: { group: "started", name: "In Progress" },
        title: "t",
    };
}

function report(over: Partial<Report>): Report {
    return { status: "done", summary: "did the thing", ...over };
}

function isJobKind(s: string): s is JobKind {
    return s === "implement" || s === "spec" || s === "triage";
}

describe("defaultDoneState", () => {
    it("maps each jobKind", () => {
        const m: Record<JobKind, string> = {
            implement: "In Review",
            spec: "Todo",
            triage: "Backlog",
        };
        for (const [jobKind, expected] of Object.entries(m)) {
            if (isJobKind(jobKind)) {
                expect(defaultDoneState(jobKind)).toBe(expected);
            }
        }
    });
});

describe("applyReport done", () => {
    it("implement done → In Review, links PR, comments", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ prUrl: "http://pr/1", status: "done" }), "implement");
        expect(r).toEqual({ movedTo: "In Review" });
        expect(t.calls).toEqual([
            { kind: "linkPR", url: "http://pr/1" },
            { body: "did the thing", kind: "comment" },
            { kind: "updateState", state: "In Review" },
        ]);
    });

    it("spec done → Todo by default", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ status: "done" }), "spec");
        expect(r.movedTo).toBe("Todo");
    });

    it("triage done → Backlog by default", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ status: "done" }), "triage");
        expect(r.movedTo).toBe("Backlog");
    });

    it("triage done → moves to Backlog AND tags triaged", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ status: "done" }), "triage");
        expect(r).toEqual({ labeled: "triaged", movedTo: "Backlog" });
        expect(t.calls).toContainEqual({ kind: "updateState", state: "Backlog" });
        expect(t.calls).toContainEqual({ kind: "addProperty", label: "triaged" });
        // updateState comes before addProperty
        const stateIdx = t.calls.findIndex((c) => c.kind === "updateState");
        const labelIdx = t.calls.findIndex((c) => c.kind === "addProperty");
        expect(stateIdx).toBeLessThan(labelIdx);
    });

    it("implement done does NOT tag triaged", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ status: "done" }), "implement");
        expect(r.labeled).toBeUndefined();
        expect(t.calls.some((c) => c.kind === "addProperty")).toBe(false);
    });

    it("done always routes to defaultDoneState(jobKind), ignoring any extra fields", async () => {
        const t = new FakeTracker();
        const r = await applyReport(
            t,
            issue(),
            { ...report({ status: "done" }), extra: "In Review" } as Report,
            "spec",
        );
        expect(r.movedTo).toBe("Todo");
    });

    it("done without a PR does not link", async () => {
        const t = new FakeTracker();
        await applyReport(t, issue(), report({ status: "done" }), "implement");
        expect(t.calls.some((c) => c.kind === "linkPR")).toBe(false);
    });
});

describe("applyReport needs_input", () => {
    it("moves to Needs Input and lists questions in the comment", async () => {
        const t = new FakeTracker();
        const r = await applyReport(
            t,
            issue(),
            report({
                questions: ["Cap retries at 3 or configurable?"],
                status: "needs_input",
                summary: "one decision left",
            }),
            "implement",
        );
        expect(r).toEqual({ movedTo: "Needs Input" });
        const comment = t.calls.find((c): c is Extract<Call, { kind: "comment" }> => c.kind === "comment");
        expect(comment?.body).toContain("- Cap retries at 3 or configurable?");
    });
});

describe("applyReport blocked", () => {
    it("adds the blocked label AND moves to Needs Input", async () => {
        const t = new FakeTracker();
        const r = await applyReport(
            t,
            issue(),
            report({ notes: "waiting on upstream", status: "blocked" }),
            "implement",
        );
        expect(r).toEqual({ labeled: "blocked", movedTo: "Needs Input" });
        expect(t.calls).toContainEqual({ kind: "addProperty", label: "blocked" });
        expect(t.calls).toContainEqual({ kind: "updateState", state: "Needs Input" });
    });

    it("includes notes in the comment body", async () => {
        const t = new FakeTracker();
        await applyReport(
            t,
            issue(),
            report({ notes: "waiting on upstream", status: "blocked", summary: "s" }),
            "implement",
        );
        const comment = t.calls.find((c): c is Extract<Call, { kind: "comment" }> => c.kind === "comment");
        expect(comment?.body).toContain("waiting on upstream");
    });
});

describe("applyReport telemetry suffix", () => {
    it("appends the telemetry line to the comment body when passed", async () => {
        const t = new FakeTracker();
        await applyReport(t, issue(), report({ status: "done" }), "implement", "beflow: 140 tok · model sonnet");
        const comment = t.calls.find((c): c is Extract<Call, { kind: "comment" }> => c.kind === "comment");
        expect(comment?.body).toContain("beflow: 140 tok · model sonnet");
        expect(comment?.body).toBe("did the thing\n\nbeflow: 140 tok · model sonnet");
    });

    it("leaves the comment body unchanged when telemetry is undefined", async () => {
        const t = new FakeTracker();
        await applyReport(t, issue(), report({ status: "done" }), "implement");
        const comment = t.calls.find((c): c is Extract<Call, { kind: "comment" }> => c.kind === "comment");
        expect(comment?.body).toBe("did the thing");
    });

    it("ignores a blank telemetry string", async () => {
        const t = new FakeTracker();
        await applyReport(t, issue(), report({ status: "done" }), "implement", "   ");
        const comment = t.calls.find((c): c is Extract<Call, { kind: "comment" }> => c.kind === "comment");
        expect(comment?.body).toBe("did the thing");
    });
});

describe("applyReport failed", () => {
    it("adds the failed label AND moves to Needs Input", async () => {
        const t = new FakeTracker();
        const r = await applyReport(t, issue(), report({ notes: "broke", status: "failed" }), "implement");
        expect(r).toEqual({ labeled: "failed", movedTo: "Needs Input" });
        expect(t.calls).toContainEqual({ kind: "addProperty", label: "failed" });
        expect(t.calls).toContainEqual({ kind: "updateState", state: "Needs Input" });
        expect(t.calls.some((c) => c.kind === "comment")).toBe(true);
    });
});
