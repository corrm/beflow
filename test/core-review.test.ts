import { describe, expect, it } from "bun:test";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import { extractReviewReport, runReview } from "../src/core/review.ts";
import type { PrCommenter, RunReviewDeps } from "../src/core/review.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import { loadRecord, saveRecord } from "../src/core/runstore.ts";
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

const REVIEW_BLOCK = [
    "Here is my review.",
    "```beflow-review",
    JSON.stringify({
        findings: [
            { comment: "null deref possible", file: "src/a.ts", line: 12, severity: "blocker" },
            { comment: "rename for clarity", severity: "nit" },
        ],
        summary: "Looks mostly good.",
    }),
    "```",
].join("\n");

describe("extractReviewReport", () => {
    it("parses a valid beflow-review block", () => {
        const text = [
            "```beflow-review",
            JSON.stringify({ findings: [{ comment: "x", severity: "major" }], summary: "s" }),
            "```",
        ].join("\n");
        expect(extractReviewReport(text)).toEqual({
            findings: [{ comment: "x", severity: "major" }],
            summary: "s",
        });
    });

    it("parses an empty findings array", () => {
        const text = '```beflow-review\n{"summary":"clean","findings":[]}\n```';
        expect(extractReviewReport(text)).toEqual({ findings: [], summary: "clean" });
    });

    it("uses the LAST block when several exist", () => {
        const text = [
            "```beflow-review",
            '{"summary":"first","findings":[]}',
            "```",
            "reconsidering...",
            "```beflow-review",
            '{"summary":"second","findings":[]}',
            "```",
        ].join("\n");
        expect(extractReviewReport(text)?.summary).toBe("second");
    });

    it("tolerates CRLF and trailing whitespace after the info string", () => {
        const text = '```beflow-review  \r\n{"summary":"s","findings":[]}\r\n```';
        expect(extractReviewReport(text)).toEqual({ findings: [], summary: "s" });
    });

    it("returns null when no block is present", () => {
        expect(extractReviewReport("no review here")).toBeNull();
    });

    it("returns null on invalid JSON", () => {
        expect(extractReviewReport("```beflow-review\n{nope}\n```")).toBeNull();
    });

    it("returns null on an invalid severity", () => {
        const text = '```beflow-review\n{"summary":"s","findings":[{"comment":"x","severity":"huge"}]}\n```';
        expect(extractReviewReport(text)).toBeNull();
    });

    it("returns null when summary is missing", () => {
        expect(extractReviewReport('```beflow-review\n{"findings":[]}\n```')).toBeNull();
    });

    it("does NOT match a plain beflow-report block", () => {
        const text = '```beflow-report\n{"status":"done","summary":"x"}\n```';
        expect(extractReviewReport(text)).toBeNull();
    });
});

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
        state: { group: "started", name: "In Review" },
        title: "t",
        type: "Bug",
        ...over,
    };
}

interface TrackerCall {
    stateUpdates: { key: string; state: string }[];
    posted: { key: string; body: string }[];
}

class ReviewTracker implements Tracker {
    readonly calls: TrackerCall = { posted: [], stateUpdates: [] };
    constructor(private readonly issues: Record<string, Issue>) {}
    async getIssue(key: string): Promise<Issue> {
        const i = this.issues[key];
        if (i === undefined) {
            throw new Error(`no issue ${key}`);
        }
        return i;
    }
    async createIssue(_p: string, d: IssueDraft): Promise<Issue> {
        return issue({ key: "CG-NEW", title: d.title });
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(_f: QueueFilter): Promise<Issue[]> {
        return [];
    }
    async updateState(i: Issue, stateName: string): Promise<void> {
        this.calls.stateUpdates.push({ key: i.key, state: stateName });
    }
    async assign(): Promise<void> {}
    async addProperty(): Promise<void> {}
    async removeProperty(): Promise<void> {}
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(i: Issue, body: string): Promise<void> {
        this.calls.posted.push({ body, key: i.key });
    }
    async listComments(): Promise<Comment[]> {
        return [];
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
        return { labels: [], modules: [], states: [], types: [] };
    }
    async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
}

function fakeDriver(assistantText: string): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report: null,
                stream: { assistantText, toolCalls: [] },
                timedOut: false,
            };
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

const prompts = loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });

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

function baseDeps(over: Partial<RunReviewDeps> & { tracker: Tracker; driver: AgentDriver }): RunReviewDeps {
    return {
        config,
        pathExists: () => true,
        prompts,
        registry,
        reviewSha: async () => "newsha",
        ...over,
    };
}

describe("runReview", () => {
    it("posts the findings to the issue, never to the PR, when postToPr is off", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver, seen } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const prPosts: { prUrl: string; body: string }[] = [];
        const prCommenter: PrCommenter = async (prUrl, body) => {
            prPosts.push({ body, prUrl });
        };
        const out = await runReview("CG-3", baseDeps({ driver, prCommenter, runsFs: fs, tracker }));
        expect(out).toEqual({ findings: 2, reviewed: true });
        expect(tracker.calls.posted).toHaveLength(1);
        expect(tracker.calls.posted[0]!.body).toContain("Looks mostly good.");
        expect(tracker.calls.posted[0]!.body).toContain("[blocker] src/a.ts:12 — null deref possible");
        expect(prPosts).toHaveLength(0);
        // The review session is its own key, and it dispatches one agent run.
        expect(seen).toHaveLength(1);
        expect(seen[0]!.sessionKey).toBe("CG-3:review");
    });

    it("also posts to the PR when postToPr is true", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const prPosts: { prUrl: string; body: string }[] = [];
        const prCommenter: PrCommenter = async (prUrl, body) => {
            prPosts.push({ body, prUrl });
        };
        await runReview("CG-3", baseDeps({ driver, postToPr: true, prCommenter, runsFs: fs, tracker }));
        expect(tracker.calls.posted).toHaveLength(1);
        expect(prPosts).toHaveLength(1);
        expect(prPosts[0]!.prUrl).toBe("https://github.com/x/y/pull/1");
    });

    it("never changes board state", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(tracker.calls.stateUpdates).toHaveLength(0);
    });

    it("stamps reviewedSha on the record", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(loadRecord("/runs", "CG-3", fs)?.reviewedSha).toBe("newsha");
        // Status is left untouched.
        expect(loadRecord("/runs", "CG-3", fs)?.status).toBe("done");
    });

    it("skips (no dispatch, no comment) when the issue is not In Review", async () => {
        const tracker = new ReviewTracker({
            "CG-3": issue({ key: "CG-3", state: { group: "completed", name: "Done" } }),
        });
        const { driver, seen } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const out = await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(out.reviewed).toBe(false);
        expect(out.reason).toBe("not-in-review");
        expect(seen).toHaveLength(0);
        expect(tracker.calls.posted).toHaveLength(0);
    });

    it("skips (no dispatch, no comment) when there is no PR on record", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver, seen } = fakeDriver(REVIEW_BLOCK);
        const { fs } = memRunsFs();
        reviewRecord(fs, { prUrl: undefined });
        const out = await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(out.reviewed).toBe(false);
        expect(out.reason).toBe("no-pr");
        expect(seen).toHaveLength(0);
        expect(tracker.calls.posted).toHaveLength(0);
    });

    it("does not post when the agent emits no review block", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const { driver } = fakeDriver("no block here");
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const out = await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(out.reviewed).toBe(false);
        expect(out.reason).toBe("no-report");
        expect(tracker.calls.posted).toHaveLength(0);
    });

    it("posts a clean message for an empty findings array", async () => {
        const tracker = new ReviewTracker({ "CG-3": issue({ key: "CG-3" }) });
        const clean = '```beflow-review\n{"summary":"All good.","findings":[]}\n```';
        const { driver } = fakeDriver(clean);
        const { fs } = memRunsFs();
        reviewRecord(fs);
        const out = await runReview("CG-3", baseDeps({ driver, runsFs: fs, tracker }));
        expect(out).toEqual({ findings: 0, reviewed: true });
        expect(tracker.calls.posted[0]!.body).toContain("No findings");
    });
});
