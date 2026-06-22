import { describe, expect, it } from "bun:test";

import type { Config } from "../src/config/schema.ts";
import { buildReceiptContext, formatReceiptBody, TrackerCommentSink } from "../src/core/decision-receipt.ts";
import { buildDecisionEvent, CompositeSink } from "../src/core/decisionlog.ts";
import type { DecisionEvent, DecisionSink, NewDecisionEvent } from "../src/core/decisionlog.ts";
import { loadDecisionReceiptPrompt } from "../src/core/prompts.ts";
import type { PromptResolveDeps } from "../src/core/prompts.ts";
import { buildDefaultDecisionSink } from "../src/core/run.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import type { ChangeReceipt, Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    Comment,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    ProjectCreateResult,
    Tracker,
} from "../src/trackers/tracker.ts";

const fixedClock = (): string => "2026-06-20T00:00:00.000Z";
const fixedId = (): string => "decision-1";

// Resolve deps that always miss, so loadDecisionReceiptPrompt yields the
// compiled-in default — the template the production default sink ships with.
const compiledOnlyDeps: PromptResolveDeps = {
    configDir: "/cfg",
    exists: () => false,
    home: "/home",
    read: () => "",
};
const defaultTemplate = loadDecisionReceiptPrompt(compiledOnlyDeps);

function makeIssue(over: Partial<Issue> = {}): Issue {
    return {
        areas: [],
        body: "boom",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: {},
        state: { group: "started", name: "In Progress" },
        title: "Crash",
        type: "Bug",
        ...over,
    };
}

function newEvent(over: Partial<NewDecisionEvent> = {}): DecisionEvent {
    const input: NewDecisionEvent = {
        changedFiles: ["src/a.ts"],
        decision: "allow",
        evaluator: "globs",
        key: "CG-42",
        matchedRules: [],
        prUrl: "https://gh/pr/9",
        reason: "no policy rule matched",
        runId: "CG-42@2026-06-20T00:00:00.000Z",
        ...over,
    };
    return buildDecisionEvent(input, fixedClock, fixedId);
}

interface CommentCall {
    issue: Issue;
    body: string;
}

class RecordingTracker implements Tracker {
    public readonly comments: CommentCall[] = [];

    public constructor(private readonly fail = false) {}

    public async comment(issue: Issue, body: string): Promise<void> {
        if (this.fail) {
            throw new Error("tracker offline");
        }
        this.comments.push({ body, issue });
    }

    public async getIssue(): Promise<Issue> {
        return makeIssue();
    }
    public async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    public async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    public async createIssue(): Promise<Issue> {
        return makeIssue();
    }
    public async listQueue(): Promise<Issue[]> {
        return [];
    }
    public async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    public async updateState(): Promise<void> {}
    public async assign(): Promise<void> {}
    public async addProperty(): Promise<void> {}
    public async removeProperty(): Promise<void> {}
    public async createProperty(): Promise<void> {}
    public async deleteProperty(): Promise<void> {}
    public async listComments(): Promise<Comment[]> {
        return [];
    }
    public async linkPR(): Promise<void> {}
    public readMetadata(issue: Issue): IssueMeta {
        return issue.meta;
    }
    public async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    public async acceptInbox(): Promise<void> {}
    public async inspectBoard(): Promise<BoardState> {
        return { labels: [], modules: [], states: [], types: [] };
    }
    public async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    public async createProject(): Promise<ProjectCreateResult> {
        return {};
    }
    public async verifyAuth(): Promise<void> {}
    public async findProjectId(): Promise<string | null> {
        return null;
    }
}

function memFs(): { fs: RunStoreFs; store: Map<string, string> } {
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

function baseConfig(decisions?: Config["decisions"]): Config {
    return {
        agent: "claude",
        agents: { claude: { command: "claude" } },
        onManualMove: "yield",
        runMode: "autonomous",
        tracker: "plane",
        trackers: {},
        ...(decisions !== undefined ? { decisions } : {}),
    };
}

describe("buildReceiptContext", () => {
    it("exposes the raw and composed values for allow/require_approval/block", () => {
        for (const [decision, label] of [
            ["allow", "ALLOW"],
            ["require_approval", "REQUIRE APPROVAL"],
            ["block", "BLOCK"],
        ] as const) {
            const ctx = buildReceiptContext(newEvent({ decision, reason: `because ${decision}` }));
            expect(ctx.decision).toBe(label);
            expect(ctx.evaluator).toBe("globs");
            expect(ctx.reason).toBe(`because ${decision}`);
            expect(ctx.fileCount).toBe("1");
            expect(ctx.changedFilesList).toBe("\n  - `src/a.ts`");
            expect(ctx.prUrl).toBe("https://gh/pr/9");
            expect(ctx.prLine).toBe("\n- PR: https://gh/pr/9");
            expect(ctx.key).toBe("CG-42");
            expect(ctx.runId).toBe("CG-42@2026-06-20T00:00:00.000Z");
            expect(ctx.timestamp).toBe("2026-06-20T00:00:00.000Z");
        }
    });

    it("caps the composed file list at 20 and appends the remaining count", () => {
        const files = Array.from({ length: 25 }, (_, i) => `src/f${String(i)}.ts`);
        const ctx = buildReceiptContext(newEvent({ changedFiles: files }));
        expect(ctx.fileCount).toBe("25");
        expect(ctx.changedFilesList).toContain("`src/f0.ts`");
        expect(ctx.changedFilesList).toContain("`src/f19.ts`");
        expect(ctx.changedFilesList).not.toContain("`src/f20.ts`");
        expect(ctx.changedFilesList).toContain("+5 more");
    });

    it("composes empty list/pr values when there are no files and no prUrl", () => {
        const ctx = buildReceiptContext(newEvent({ changedFiles: [], prUrl: undefined }));
        expect(ctx.fileCount).toBe("0");
        expect(ctx.changedFilesList).toBe("");
        expect(ctx.prUrl).toBe("");
        expect(ctx.prLine).toBe("");
    });

    it("composes the receipt-derived intent, risk surfaces, and surface notes", () => {
        const receipt: ChangeReceipt = {
            intent: "rotate the session secret",
            riskSurfaces: ["auth", "deps"],
            surfaceNotes: { auth: "new TTL", deps: "bumps jose" },
        };
        const ctx = buildReceiptContext(newEvent({ receipt }));
        expect(ctx.intentLine).toBe("\n- Agent intent: rotate the session secret");
        expect(ctx.riskSurfacesLine).toBe("\n- Risk surfaces: auth, deps");
        expect(ctx.surfaceNotesList).toBe("\n  - `auth`: new TTL\n  - `deps`: bumps jose");
    });

    it("composes empty receipt values when there is no receipt", () => {
        const ctx = buildReceiptContext(newEvent());
        expect(ctx.intentLine).toBe("");
        expect(ctx.riskSurfacesLine).toBe("");
        expect(ctx.surfaceNotesList).toBe("");
    });

    it("omits the risk-surfaces and notes lines for an intent-only receipt", () => {
        const receipt: ChangeReceipt = { intent: "tidy app code", riskSurfaces: [] };
        const ctx = buildReceiptContext(newEvent({ receipt }));
        expect(ctx.intentLine).toBe("\n- Agent intent: tidy app code");
        expect(ctx.riskSurfacesLine).toBe("");
        expect(ctx.surfaceNotesList).toBe("");
    });

    it("caps the surface-notes list at 20 and appends the remaining count", () => {
        const surfaceNotes: Record<string, string> = {};
        for (let i = 0; i < 25; i++) {
            surfaceNotes[`surface-${String(i)}`] = `note ${String(i)}`;
        }
        const receipt: ChangeReceipt = {
            intent: "wide change",
            riskSurfaces: ["app"],
            surfaceNotes: surfaceNotes as ChangeReceipt["surfaceNotes"],
        };
        const ctx = buildReceiptContext(newEvent({ receipt }));
        expect(ctx.surfaceNotesList).toContain("note 0");
        expect(ctx.surfaceNotesList).toContain("note 19");
        expect(ctx.surfaceNotesList).not.toContain("note 20");
        expect(ctx.surfaceNotesList).toContain("+5 more");
    });
});

describe("formatReceiptBody", () => {
    it("renders the decision word, evaluator, reason, file count, and pr for allow/require_approval/block", () => {
        for (const [decision, label] of [
            ["allow", "ALLOW"],
            ["require_approval", "REQUIRE APPROVAL"],
            ["block", "BLOCK"],
        ] as const) {
            const body = formatReceiptBody(defaultTemplate, newEvent({ decision, reason: `because ${decision}` }));
            expect(body).toContain(label);
            expect(body).toContain("globs");
            expect(body).toContain(`because ${decision}`);
            expect(body).toContain("Changed files: 1");
            expect(body).toContain("`src/a.ts`");
            expect(body).toContain("https://gh/pr/9");
        }
    });

    it("caps the listed files and reports the remaining count", () => {
        const files = Array.from({ length: 25 }, (_, i) => `src/f${String(i)}.ts`);
        const body = formatReceiptBody(defaultTemplate, newEvent({ changedFiles: files }));
        expect(body).toContain("Changed files: 25");
        expect(body).toContain("`src/f0.ts`");
        expect(body).toContain("`src/f19.ts`");
        expect(body).not.toContain("`src/f20.ts`");
        expect(body).toContain("+5 more");
    });

    it("omits the pr line when no prUrl is present", () => {
        const body = formatReceiptBody(defaultTemplate, newEvent({ prUrl: undefined }));
        expect(body).not.toContain("PR:");
    });

    it("renders a custom user template, proving the override mechanism works", () => {
        const body = formatReceiptBody("Decision={{decision}} Files={{fileCount}}", newEvent({ decision: "block" }));
        expect(body).toBe("Decision=BLOCK Files=1");
    });

    it("surfaces the agent intent, risk surfaces, and notes when a receipt is present", () => {
        const receipt: ChangeReceipt = {
            intent: "rotate the session secret",
            riskSurfaces: ["auth", "deps"],
            surfaceNotes: { auth: "new TTL" },
        };
        const body = formatReceiptBody(defaultTemplate, newEvent({ decision: "require_approval", receipt }));
        expect(body).toContain("Agent intent: rotate the session secret");
        expect(body).toContain("Risk surfaces: auth, deps");
        expect(body).toContain("`auth`: new TTL");
    });

    it("renders no dangling receipt lines and keeps the prior shape when no receipt is present", () => {
        const body = formatReceiptBody(defaultTemplate, newEvent());
        expect(body).not.toContain("Agent intent:");
        expect(body).not.toContain("Risk surfaces:");
        expect(body).toBe(
            [
                "**Policy decision: ALLOW**",
                "",
                "- Evaluator: `globs`",
                "- Reason: no policy rule matched",
                "- Changed files: 1",
                "  - `src/a.ts`",
                "- PR: https://gh/pr/9",
                "",
            ].join("\n"),
        );
    });
});

describe("loadDecisionReceiptPrompt", () => {
    it("returns a user override file when present", () => {
        const deps: PromptResolveDeps = {
            configDir: "/cfg",
            exists: (p) => p === "/cfg/prompts/decision-receipt.md",
            home: "/home",
            read: () => "custom receipt {{decision}}",
        };
        expect(loadDecisionReceiptPrompt(deps)).toBe("custom receipt {{decision}}");
    });

    it("falls back to the compiled default when no override file exists", () => {
        expect(loadDecisionReceiptPrompt(compiledOnlyDeps)).toContain("Policy decision: {{decision}}");
    });
});

describe("TrackerCommentSink", () => {
    it("posts exactly one receipt comment on the issue", async () => {
        const tracker = new RecordingTracker();
        const sink = new TrackerCommentSink(tracker, makeIssue(), defaultTemplate, () => {});
        await sink.emit(newEvent({ decision: "block", reason: "infra is off-limits" }));
        expect(tracker.comments).toHaveLength(1);
        expect(tracker.comments[0]?.issue.key).toBe("CG-42");
        expect(tracker.comments[0]?.body).toContain("BLOCK");
        expect(tracker.comments[0]?.body).toContain("infra is off-limits");
    });

    it("is best-effort: a failing tracker resolves and logs instead of throwing", async () => {
        const tracker = new RecordingTracker(true);
        const logs: string[] = [];
        const sink = new TrackerCommentSink(tracker, makeIssue(), defaultTemplate, (msg) => {
            logs.push(msg);
        });
        await sink.emit(newEvent());
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("decision receipt comment failed");
        expect(logs[0]).toContain("tracker offline");
    });

    it("is best-effort: a broken custom template logs and never throws", async () => {
        const tracker = new RecordingTracker();
        const logs: string[] = [];
        const sink = new TrackerCommentSink(tracker, makeIssue(), "{{nope}}", (msg) => {
            logs.push(msg);
        });
        await sink.emit(newEvent());
        expect(tracker.comments).toHaveLength(0);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("decision receipt comment failed");
        expect(logs[0]).toContain("nope");
    });
});

describe("CompositeSink", () => {
    it("fans the event out to every sub-sink in order", async () => {
        const seen: { sink: string; id: string }[] = [];
        const localDouble: DecisionSink = {
            emit: async (e) => {
                seen.push({ id: e.decisionId, sink: "local" });
            },
        };
        const tracker = new RecordingTracker();
        const composite = new CompositeSink([
            localDouble,
            new TrackerCommentSink(tracker, makeIssue(), defaultTemplate, () => {}),
        ]);
        const event = newEvent();
        await composite.emit(event);
        expect(seen).toEqual([{ id: "decision-1", sink: "local" }]);
        expect(tracker.comments).toHaveLength(1);
        expect(tracker.comments[0]?.body).toContain("ALLOW");
    });
});

describe("buildDefaultDecisionSink", () => {
    it("posts a receipt by default (comment unset)", async () => {
        const { fs, store } = memFs();
        const tracker = new RecordingTracker();
        const sink = buildDefaultDecisionSink(baseConfig(), tracker, makeIssue(), fs, defaultTemplate, () => {});
        await sink.emit(newEvent());
        expect(tracker.comments).toHaveLength(1);
        expect([...store.values()].join("")).toContain("decision-1");
    });

    it("posts a receipt when comment is explicitly true", async () => {
        const { fs } = memFs();
        const tracker = new RecordingTracker();
        const sink = buildDefaultDecisionSink(
            baseConfig({ comment: true }),
            tracker,
            makeIssue(),
            fs,
            defaultTemplate,
            () => {},
        );
        await sink.emit(newEvent());
        expect(tracker.comments).toHaveLength(1);
    });

    it("writes the durable log but posts NO receipt when comment is false", async () => {
        const { fs, store } = memFs();
        const tracker = new RecordingTracker();
        const sink = buildDefaultDecisionSink(
            baseConfig({ comment: false }),
            tracker,
            makeIssue(),
            fs,
            defaultTemplate,
            () => {},
        );
        await sink.emit(newEvent());
        expect(tracker.comments).toHaveLength(0);
        expect([...store.values()].join("")).toContain("decision-1");
    });
});
