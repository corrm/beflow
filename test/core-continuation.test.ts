import { describe, expect, it } from "bun:test";

import { assembleContinuation, renderContinuation } from "../src/core/continuation.ts";
import type { ContinuationContext } from "../src/core/continuation.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import type { RunRecord } from "../src/core/runstore.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type { Comment, ProjectCreateResult, Tracker } from "../src/trackers/tracker.ts";

const defaultPrompts = loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });

// ---------------------------------------------------------------------------
// Minimal fake tracker — only listComments needs to return real data.
// ---------------------------------------------------------------------------

function makeIssue(): Issue {
    return {
        areas: [],
        body: "body",
        id: "wi-1",
        key: "CG-1",
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "Fix it",
        type: "Bug",
    };
}

function fakeTracker(comments: Comment[]): Tracker {
    const notImpl = (): never => {
        throw new Error("not implemented");
    };
    return {
        acceptInbox: notImpl,
        activeCycleIssueIds: async () => null,
        addProperty: notImpl,
        assign: notImpl,
        blockedBy: async () => [],
        comment: notImpl,
        createIssue: notImpl,
        createProperty: notImpl,
        deleteProperty: notImpl,
        ensureBoard: notImpl,
        getIssue: notImpl,
        inspectBoard: notImpl,
        issueContext: async () => ({ attachments: [] }),
        linkPR: notImpl,
        listComments: async () => comments,
        listInbox: notImpl,
        listQueue: notImpl,
        createProject: async (): Promise<ProjectCreateResult> => {
            throw new Error("not implemented");
        },
        findProjectId: async () => null,
        readMetadata: (issue: Issue): IssueMeta => issue.meta,
        removeProperty: notImpl,
        updateState: notImpl,
        verifyAuth: async () => {},
    };
}

function makeComment(over: Partial<Comment>): Comment {
    return {
        body: "hello",
        createdAt: "2026-06-01T00:00:00.000Z",
        id: "c-1",
        isBot: false,
        ...over,
    };
}

function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
    return {
        agent: "claude",
        cwd: "/wt/cg-1",
        key: "CG-1",
        jobKind: "implement",
        runMode: "autonomous",
        sessionName: "CG-1",
        status: "needs_input",
        updatedAt: "2026-06-14T00:00:00.000Z",
        ...over,
    };
}

// ---------------------------------------------------------------------------
// assembleContinuation
// ---------------------------------------------------------------------------

describe("assembleContinuation", () => {
    it("keeps only human (non-bot) comments", async () => {
        const comments: Comment[] = [
            makeComment({ body: "human says hi", id: "h1", isBot: false }),
            makeComment({ body: "bot reply", id: "b1", isBot: true }),
            makeComment({ body: "another human", id: "h2", isBot: false }),
        ];
        const ctx = await assembleContinuation(fakeTracker(comments), makeIssue());
        expect(ctx.newComments).toHaveLength(2);
        expect(ctx.newComments.map((c) => c.id)).toEqual(["h1", "h2"]);
    });

    it("filters out bot comments even when since is not set", async () => {
        const comments: Comment[] = [makeComment({ isBot: true }), makeComment({ id: "c-2", isBot: false })];
        const ctx = await assembleContinuation(fakeTracker(comments), makeIssue());
        expect(ctx.newComments).toHaveLength(1);
        expect(ctx.newComments[0]!.id).toBe("c-2");
    });

    describe("with since option", () => {
        const since = "2026-06-10T00:00:00.000Z";

        it("keeps only comments strictly after since", async () => {
            const comments: Comment[] = [
                makeComment({ body: "before", createdAt: "2026-06-09T23:59:59.999Z", id: "old" }),
                makeComment({ body: "exactly at", createdAt: since, id: "at" }),
                makeComment({ body: "after", createdAt: "2026-06-10T00:00:00.001Z", id: "new" }),
            ];
            const ctx = await assembleContinuation(fakeTracker(comments), makeIssue(), { since });
            expect(ctx.newComments.map((c) => c.id)).toEqual(["new"]);
        });

        it("excludes comments with empty createdAt when since is set", async () => {
            const comments: Comment[] = [
                makeComment({ createdAt: "", id: "empty" }),
                makeComment({ createdAt: "2026-06-15T00:00:00.000Z", id: "valid" }),
            ];
            const ctx = await assembleContinuation(fakeTracker(comments), makeIssue(), { since });
            expect(ctx.newComments.map((c) => c.id)).toEqual(["valid"]);
        });

        it("excludes bot comments even when they are after since", async () => {
            const comments: Comment[] = [
                makeComment({ createdAt: "2026-06-15T00:00:00.000Z", id: "bot", isBot: true }),
                makeComment({ createdAt: "2026-06-15T00:00:00.000Z", id: "human", isBot: false }),
            ];
            const ctx = await assembleContinuation(fakeTracker(comments), makeIssue(), { since });
            expect(ctx.newComments.map((c) => c.id)).toEqual(["human"]);
        });
    });

    describe("prUrl and priorReport from record", () => {
        it("returns prUrl from the record when set", async () => {
            const record = makeRecord({ prUrl: "https://github.com/org/repo/pull/42" });
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue(), { record });
            expect(ctx.prUrl).toBe("https://github.com/org/repo/pull/42");
        });

        it("returns undefined prUrl when record has no prUrl", async () => {
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue(), { record: makeRecord() });
            expect(ctx.prUrl).toBeUndefined();
        });

        it("returns priorReport from the record when set", async () => {
            const report = { status: "needs_input" as const, summary: "waiting on design" };
            const record = makeRecord({ report });
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue(), { record });
            expect(ctx.priorReport).toEqual(report);
        });

        it("returns undefined priorReport when record has no report", async () => {
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue(), { record: makeRecord() });
            expect(ctx.priorReport).toBeUndefined();
        });

        it("returns undefined prUrl and priorReport when no record is provided", async () => {
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue());
            expect(ctx.prUrl).toBeUndefined();
            expect(ctx.priorReport).toBeUndefined();
        });

        it("returns undefined prUrl and priorReport when record is null", async () => {
            const ctx = await assembleContinuation(fakeTracker([]), makeIssue(), { record: null });
            expect(ctx.prUrl).toBeUndefined();
            expect(ctx.priorReport).toBeUndefined();
        });
    });
});

// ---------------------------------------------------------------------------
// renderContinuation
// ---------------------------------------------------------------------------

describe("renderContinuation", () => {
    function ctx(over: Partial<ContinuationContext> = {}): ContinuationContext {
        return { newComments: [], ...over };
    }

    it("always opens with the continuation header", () => {
        const out = renderContinuation(defaultPrompts, ctx());
        expect(out).toContain("returning to you for continuation");
    });

    it("includes prior status and summary when priorReport is present", () => {
        const out = renderContinuation(
            defaultPrompts,
            ctx({ priorReport: { status: "needs_input", summary: "waiting on design" } }),
        );
        expect(out).toContain("Prior outcome: needs_input — waiting on design");
    });

    it("shows (none) for prior report when priorReport is absent", () => {
        const out = renderContinuation(defaultPrompts, ctx());
        expect(out).toContain("Prior outcome: (none)");
    });

    it("includes the PR url when prUrl is present", () => {
        const out = renderContinuation(defaultPrompts, ctx({ prUrl: "https://github.com/org/repo/pull/7" }));
        expect(out).toContain("Open PR: https://github.com/org/repo/pull/7");
    });

    it("shows (none) for PR url when prUrl is absent", () => {
        const out = renderContinuation(defaultPrompts, ctx());
        expect(out).toContain("Open PR: (none)");
    });

    it("renders each new comment body as a bullet", () => {
        const comments: Comment[] = [
            makeComment({ body: "please add tests", id: "c1" }),
            makeComment({ body: "also fix the linter", id: "c2" }),
        ];
        const out = renderContinuation(defaultPrompts, ctx({ newComments: comments }));
        expect(out).toContain("- please add tests");
        expect(out).toContain("- also fix the linter");
    });

    it("shows No new comments. when the comment list is empty", () => {
        const out = renderContinuation(defaultPrompts, ctx());
        expect(out).toContain("No new comments.");
    });

    it("includes all sections together when all fields are present", () => {
        const comments: Comment[] = [makeComment({ body: "LGTM", id: "c1" })];
        const out = renderContinuation(
            defaultPrompts,
            ctx({
                newComments: comments,
                priorReport: { status: "blocked", summary: "waiting on API key" },
                prUrl: "https://github.com/org/repo/pull/99",
            }),
        );
        expect(out).toContain("Prior outcome: blocked — waiting on API key");
        expect(out).toContain("Open PR: https://github.com/org/repo/pull/99");
        expect(out).toContain("- LGTM");
        expect(out).not.toContain("No new comments.");
    });
});
