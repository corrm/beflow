import { describe, expect, it } from "bun:test";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import {
    WebhookNotifier,
    createNotifier,
    detectFormat,
    escalationDetail,
    noopNotifier,
    notifyEscalation,
} from "../src/core/notify.ts";
import type { FetchFn, NotifyEvent, Notifier } from "../src/core/notify.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import { runIssue, runOpen } from "../src/core/run.ts";
import type { RunIssueDeps, RunOpenDeps } from "../src/core/run.ts";
import type { Clock, RunStoreFs } from "../src/core/runstore.ts";
import { saveRecord } from "../src/core/runstore.ts";
import { watchTick } from "../src/core/watch.ts";
import type { WatchDeps } from "../src/core/watch.ts";
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const config: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    runs: { dir: "/runs" },
    tracker: "plane",
    trackers: {},
    worktrees: { dir: "/wt" },
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

const prompts = loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });

const fixedClock: Clock = () => "2026-06-14T00:00:00.000Z";

function makeIssue(over: Partial<Issue> = {}): Issue {
    return {
        areas: [],
        body: "boom",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "Crash",
        type: "Bug",
        ...over,
    };
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

class FakeTracker implements Tracker {
    private movedToInProgress: boolean;
    constructor(private readonly issue: Issue) {
        this.movedToInProgress = issue.state.group === "started";
    }
    async getIssue(): Promise<Issue> {
        if (this.movedToInProgress) {
            return { ...this.issue, state: { group: "started", name: "In Progress" } };
        }
        return this.issue;
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
    async listQueue(): Promise<Issue[]> {
        return [];
    }
    async updateState(_issue: Issue, stateName: string): Promise<void> {
        if (stateName === "In Progress") {
            this.movedToInProgress = true;
        }
    }
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
    readMetadata(issue: Issue): IssueMeta {
        return issue.meta;
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return {
            labels: ["blocked", "failed", "triaged"],
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

function spyNotifier(): { events: NotifyEvent[]; notifier: Notifier } {
    const events: NotifyEvent[] = [];
    const notifier: Notifier = {
        notify: async (evt: NotifyEvent): Promise<void> => {
            events.push(evt);
        },
    };
    return { events, notifier };
}

function fakeDriver(report: AgentRunResult["report"]): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report,
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };
    return { driver, seen };
}

// Generic shape (auto-detected from non-slack/discord URLs)
interface GenericBody {
    detail?: string;
    event: string;
    issue: { key: string; title: string };
    reason: string;
    text: string;
}

// Slack body shape
interface SlackBody {
    text: string;
}

// Discord body shape
interface DiscordBody {
    content: string;
}

function isGenericBody(v: unknown): v is GenericBody {
    return (
        typeof v === "object" &&
        v !== null &&
        "event" in v &&
        "reason" in v &&
        "text" in v &&
        typeof (v as { event: unknown }).event === "string" &&
        typeof (v as { reason: unknown }).reason === "string" &&
        typeof (v as { text: unknown }).text === "string"
    );
}

function isSlackBody(v: unknown): v is SlackBody {
    return (
        typeof v === "object" &&
        v !== null &&
        "text" in v &&
        typeof (v as { text: unknown }).text === "string" &&
        !("content" in v) &&
        !("event" in v)
    );
}

function isDiscordBody(v: unknown): v is DiscordBody {
    return (
        typeof v === "object" &&
        v !== null &&
        "content" in v &&
        typeof (v as { content: unknown }).content === "string" &&
        !("text" in v)
    );
}

function parsedFetchGeneric(): { bodies: GenericBody[]; fakeFetch: FetchFn; urls: string[] } {
    const bodies: GenericBody[] = [];
    const urls: string[] = [];
    const fakeFetch: FetchFn = async (url, init) => {
        urls.push(url);
        const bodyStr = typeof init.body === "string" ? init.body : "";
        const raw: unknown = JSON.parse(bodyStr);
        if (!isGenericBody(raw)) {
            throw new Error(`parsedFetchGeneric: unexpected body shape: ${JSON.stringify(raw)}`);
        }
        bodies.push(raw);
        return new Response(null, { status: 200 });
    };
    return { bodies, fakeFetch, urls };
}

function parsedFetchSlack(): { bodies: SlackBody[]; fakeFetch: FetchFn; urls: string[] } {
    const bodies: SlackBody[] = [];
    const urls: string[] = [];
    const fakeFetch: FetchFn = async (url, init) => {
        urls.push(url);
        const bodyStr = typeof init.body === "string" ? init.body : "";
        const raw: unknown = JSON.parse(bodyStr);
        if (!isSlackBody(raw)) {
            throw new Error(`parsedFetchSlack: unexpected body shape: ${JSON.stringify(raw)}`);
        }
        bodies.push(raw);
        return new Response(null, { status: 200 });
    };
    return { bodies, fakeFetch, urls };
}

function parsedFetchDiscord(): { bodies: DiscordBody[]; fakeFetch: FetchFn; urls: string[] } {
    const bodies: DiscordBody[] = [];
    const urls: string[] = [];
    const fakeFetch: FetchFn = async (url, init) => {
        urls.push(url);
        const bodyStr = typeof init.body === "string" ? init.body : "";
        const raw: unknown = JSON.parse(bodyStr);
        if (!isDiscordBody(raw)) {
            throw new Error(`parsedFetchDiscord: unexpected body shape: ${JSON.stringify(raw)}`);
        }
        bodies.push(raw);
        return new Response(null, { status: 200 });
    };
    return { bodies, fakeFetch, urls };
}

// ---------------------------------------------------------------------------
// WebhookNotifier unit tests
// ---------------------------------------------------------------------------

describe("WebhookNotifier", () => {
    it("POSTs once to the URL with structured body for a needs_input event", async () => {
        const { bodies, fakeFetch, urls } = parsedFetchGeneric();

        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://hooks.example.com/webhook",
        });

        await notifier.notify({
            key: "CG-42",
            reason: "needs_input",
            title: "Crash",
        });

        expect(bodies).toHaveLength(1);
        expect(urls[0]).toBe("https://hooks.example.com/webhook");

        const body = bodies[0]!;
        expect(body.reason).toBe("needs_input");
        expect(body.event).toBe("beflow.escalation");
        expect(body.issue.key).toBe("CG-42");

        // Headline phrasing check
        expect(body.text).toContain("CG-42");
        expect(body.text).toContain("needs input");
        expect(body.text).toContain("Crash");
        expect(body.text.startsWith("🔔 beflow:")).toBe(true);
    });

    it("includes detail in body when provided", async () => {
        const { bodies, fakeFetch } = parsedFetchGeneric();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://hooks.example.com/webhook",
        });

        await notifier.notify({
            detail: "needs some info",
            key: "CG-42",
            reason: "needs_input",
            title: "Crash",
        });

        expect(bodies[0]!.detail).toBe("needs some info");
    });

    it("omits detail key from body when detail is undefined", async () => {
        const { bodies, fakeFetch } = parsedFetchGeneric();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://hooks.example.com/webhook",
        });

        await notifier.notify({ key: "CG-42", reason: "blocked", title: "Crash" });

        expect("detail" in bodies[0]!).toBe(false);
    });

    it("maps all reason phrases correctly", async () => {
        const { bodies, fakeFetch } = parsedFetchGeneric();
        const notifier = new WebhookNotifier({ fetchImpl: fakeFetch, url: "https://h.test" });

        await notifier.notify({ key: "X-1", reason: "needs_input", title: "T" });
        await notifier.notify({ key: "X-1", reason: "blocked", title: "T" });
        await notifier.notify({ key: "X-1", reason: "failed", title: "T" });

        expect(bodies[0]!.text).toContain("needs input");
        expect(bodies[1]!.text).toContain("is blocked");
        expect(bodies[2]!.text).toContain("failed");
    });

    it("resolves without throwing when fetch throws an error, and logs a warning", async () => {
        const logs: string[] = [];
        const fakeFetch: FetchFn = async () => {
            throw new Error("network down");
        };
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            log: (m) => {
                logs.push(m);
            },
            url: "https://hooks.example.com/webhook",
        });

        // Must not throw
        await notifier.notify({ key: "CG-42", reason: "failed", title: "Crash" });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("network down");
    });

    it("resolves without throwing on a non-ok response and logs a warning", async () => {
        const logs: string[] = [];
        const fakeFetch: FetchFn = async () => new Response(null, { status: 500, statusText: "Server Error" });
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            log: (m) => {
                logs.push(m);
            },
            url: "https://hooks.example.com/webhook",
        });

        await notifier.notify({ key: "CG-42", reason: "blocked", title: "Crash" });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain("500");
    });
});

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

describe("detectFormat", () => {
    it("returns slack for a hooks.slack.com URL", () => {
        expect(detectFormat("https://hooks.slack.com/services/T000/B000/xxxx")).toBe("slack");
    });

    it("returns discord for a discord.com URL", () => {
        expect(detectFormat("https://discord.com/api/webhooks/123/abc")).toBe("discord");
    });

    it("returns discord for a discordapp.com URL", () => {
        expect(detectFormat("https://discordapp.com/api/webhooks/123/abc")).toBe("discord");
    });

    it("returns generic for an arbitrary URL", () => {
        expect(detectFormat("https://example.com/hook")).toBe("generic");
    });

    it("returns generic for a malformed string", () => {
        expect(detectFormat("not a url at all")).toBe("generic");
    });
});

// ---------------------------------------------------------------------------
// WebhookNotifier body shape per format
// ---------------------------------------------------------------------------

describe("WebhookNotifier body shape", () => {
    it("slack URL → body has text containing headline+detail, no content/event keys", async () => {
        const { bodies, fakeFetch } = parsedFetchSlack();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://hooks.slack.com/services/T000/B000/xxxx",
        });

        await notifier.notify({ detail: "some detail", key: "CG-1", reason: "needs_input", title: "T" });

        const body = bodies[0]!;
        expect(body.text).toContain("CG-1");
        expect(body.text).toContain("some detail");
    });

    it("discord URL → body has content, no text; long detail truncated to ≤2000 chars", async () => {
        const { bodies, fakeFetch } = parsedFetchDiscord();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://discord.com/api/webhooks/123/abc",
        });

        const longDetail = "x".repeat(2000);
        await notifier.notify({ detail: longDetail, key: "CG-2", reason: "blocked", title: "T" });

        const body = bodies[0]!;
        expect(body.content.length).toBeLessThanOrEqual(2000);
    });

    it("discord URL → short message passes through untruncated", async () => {
        const { bodies, fakeFetch } = parsedFetchDiscord();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://discord.com/api/webhooks/123/abc",
        });

        await notifier.notify({ detail: "short detail", key: "CG-3", reason: "failed", title: "T" });

        const body = bodies[0]!;
        expect(body.content).toContain("CG-3");
        expect(body.content).toContain("short detail");
    });

    it("generic URL → body has text AND event/reason/issue.key", async () => {
        const { bodies, fakeFetch } = parsedFetchGeneric();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            url: "https://example.com/hook",
        });

        await notifier.notify({ key: "CG-4", reason: "failed", title: "T" });

        const body = bodies[0]!;
        expect(typeof body.text).toBe("string");
        expect(body.event).toBe("beflow.escalation");
        expect(body.reason).toBe("failed");
        expect(body.issue.key).toBe("CG-4");
    });

    it("explicit format: discord overrides slack-looking URL → content key", async () => {
        const { bodies, fakeFetch } = parsedFetchDiscord();
        const notifier = new WebhookNotifier({
            fetchImpl: fakeFetch,
            format: "discord",
            url: "https://hooks.slack.com/services/T000/B000/xxxx",
        });

        await notifier.notify({ key: "CG-5", reason: "needs_input", title: "T" });

        const body = bodies[0]!;
        expect(typeof body.content).toBe("string");
        expect(body.content).toContain("CG-5");
    });
});

// ---------------------------------------------------------------------------
// createNotifier
// ---------------------------------------------------------------------------

describe("createNotifier", () => {
    it("returns noopNotifier when webhookUrl is undefined", () => {
        const n = createNotifier({});
        expect(n).toBe(noopNotifier);
    });

    it("returns noopNotifier when webhookUrl is an empty string", () => {
        const n = createNotifier({ webhookUrl: "" });
        expect(n).toBe(noopNotifier);
    });

    it("returns a WebhookNotifier when webhookUrl is non-empty", () => {
        const n = createNotifier({ webhookUrl: "https://h.test" });
        expect(n).toBeInstanceOf(WebhookNotifier);
    });

    it("noopNotifier never POSTs even when passed a spy fetch", async () => {
        // createNotifier with no webhookUrl → noopNotifier; POST never attempted
        const { bodies, fakeFetch } = parsedFetchGeneric();
        const n = createNotifier({ fetchImpl: fakeFetch });
        await n.notify({ key: "CG-1", reason: "failed", title: "T" });
        expect(bodies).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// notifyEscalation
// ---------------------------------------------------------------------------

describe("notifyEscalation", () => {
    it("is a no-op when notifier is undefined", async () => {
        // Must not throw
        await notifyEscalation(undefined, { key: "CG-1", title: "T" }, "failed");
        // No assertion needed — reaching here means no throw
    });

    it("calls notifier.notify with the right NotifyEvent", async () => {
        const { events, notifier } = spyNotifier();
        await notifyEscalation(notifier, { key: "CG-42", title: "Crash" }, "needs_input", "- Q1\n- Q2");

        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            detail: "- Q1\n- Q2",
            key: "CG-42",
            reason: "needs_input",
            title: "Crash",
        });
    });

    it("omits detail when not passed", async () => {
        const { events, notifier } = spyNotifier();
        await notifyEscalation(notifier, { key: "CG-42", title: "Crash" }, "blocked");

        expect(events).toHaveLength(1);
        expect("detail" in events[0]!).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// escalationDetail
// ---------------------------------------------------------------------------

describe("escalationDetail", () => {
    it("returns bullet-formatted questions when present", () => {
        const result = escalationDetail({ questions: ["Who?", "What?"], summary: "Sum" });
        expect(result).toBe("- Who?\n- What?");
    });

    it("returns summary when questions array is empty", () => {
        const result = escalationDetail({ questions: [], summary: "Sum" });
        expect(result).toBe("Sum");
    });

    it("returns summary when questions is undefined", () => {
        const result = escalationDetail({ summary: "Sum" });
        expect(result).toBe("Sum");
    });
});

// ---------------------------------------------------------------------------
// Integration: runIssue — escalation path
// ---------------------------------------------------------------------------

describe("runIssue escalation integration", () => {
    function deps(over: Partial<RunIssueDeps> & { driver: AgentDriver; tracker: Tracker }): RunIssueDeps {
        return {
            clock: fixedClock,
            config,
            pathExists: () => false,
            prompts,
            registry,
            runsFs: memRunsFs().fs,
            ...over,
        };
    }

    it("fires notifier with needs_input reason when report is needs_input", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({
            questions: ["What color?"],
            status: "needs_input",
            summary: "Waiting for answer",
        });
        const { events, notifier } = spyNotifier();

        await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("needs_input");
        expect(events[0]!.key).toBe("CG-42");
        // escalationDetail should produce bullet list (questions present)
        expect(events[0]!.detail).toBe("- What color?");
    });

    it("fires notifier with blocked reason when report is blocked", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "blocked", summary: "Dependency missing" });
        const { events, notifier } = spyNotifier();

        await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("blocked");
        expect(events[0]!.detail).toBe("Dependency missing");
    });

    it("fires notifier with failed reason when report is failed", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "failed", summary: "Exploded" });
        const { events, notifier } = spyNotifier();

        await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("failed");
    });

    it("does NOT fire notifier on a done report", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "done", summary: "Shipped" });
        const { events, notifier } = spyNotifier();

        await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        expect(events).toHaveLength(0);
    });

    it("does NOT fire notifier when no report is produced", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver(null);
        const { events, notifier } = spyNotifier();

        await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        expect(events).toHaveLength(0);
    });

    it("YIELD path: does NOT fire notifier on a manual move (yield)", async () => {
        // FlipTracker: first read returns the issue as-is (unstarted),
        // subsequent reads return cancelled (simulating a manual pull).
        class FlipTracker extends FakeTracker {
            private reads = 0;
            constructor() {
                super(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }));
            }
            override async getIssue(): Promise<Issue> {
                this.reads += 1;
                const base = makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } });
                if (this.reads === 1) {
                    return base;
                }
                return { ...base, state: { group: "cancelled", name: "Cancelled" } };
            }
        }

        const tracker = new FlipTracker();
        const { driver } = fakeDriver({ status: "needs_input", summary: "Waiting" });
        const { events, notifier } = spyNotifier();

        const result = await runIssue("CG-42", {}, deps({ driver, notify: notifier, tracker }));

        // The yield path skips writeback and must NOT fire the notifier.
        expect(result.applied).toBeUndefined();
        expect(events).toHaveLength(0);
    });

    it("works when notify is undefined (backward-compat, no throw)", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "needs_input", summary: "Waiting" });

        const result = await runIssue("CG-42", {}, deps({ driver, tracker }));
        expect(result.result.report?.status).toBe("needs_input");
    });
});

// ---------------------------------------------------------------------------
// Integration: runOpen escalation
// ---------------------------------------------------------------------------

describe("runOpen escalation integration", () => {
    function deps(over: Partial<RunOpenDeps> & { tracker: Tracker }): RunOpenDeps {
        return {
            clock: fixedClock,
            config,
            prompts,
            registry,
            runsFs: memRunsFs().fs,
            ...over,
        };
    }

    it("fires notifier with blocked reason when outcome is blocked", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { events, notifier } = spyNotifier();

        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "blocked" }),
                notify: notifier,
                openIssue: async () => {},
                tracker,
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("blocked");
        expect(events[0]!.key).toBe("CG-42");
    });

    it("fires notifier with failed reason when outcome is failed", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { events, notifier } = spyNotifier();

        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "failed" }),
                notify: notifier,
                openIssue: async () => {},
                tracker,
            }),
        );

        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("failed");
    });

    it("does NOT fire notifier on a done outcome", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { events, notifier } = spyNotifier();

        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                notify: notifier,
                openIssue: async () => {},
                tracker,
            }),
        );

        expect(events).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Integration: watch dead-letter → quarantine notification
// ---------------------------------------------------------------------------

interface WatchQueues {
    inProgress?: Issue[];
    inReview: Issue[];
    todo: Issue[];
}

class WatchTracker implements Tracker {
    constructor(private readonly queues: WatchQueues) {}
    async getIssue(key: string): Promise<Issue> {
        return watchIssue(key);
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async createIssue(_project: string, draft: IssueDraft): Promise<Issue> {
        return { ...watchIssue("CG-NEW"), title: draft.title };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(f: QueueFilter): Promise<Issue[]> {
        if (f.state === "In Review") {
            return this.queues.inReview;
        }
        if (f.state === "In Progress") {
            return this.queues.inProgress ?? [];
        }
        if (f.state === "Todo") {
            return this.queues.todo;
        }
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
    readMetadata(i: Issue): IssueMeta {
        return i.meta;
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return {
            labels: ["blocked", "failed", "triaged"],
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

function watchIssue(key: string): Issue {
    return {
        areas: [],
        body: "",
        id: key,
        key,
        labels: [],
        meta: {},
        state: { group: "started", name: "In Progress" },
        title: "Watch issue",
        type: "Bug",
    };
}

function watchDeps(over: Partial<WatchDeps> & { driver: AgentDriver; tracker: Tracker }): WatchDeps {
    return {
        clock: fixedClock,
        config,
        prompts,
        registry,
        runsFs: memRunsFs().fs,
        ...over,
    };
}

function fakeWatchDriver(): AgentDriver {
    return {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (): Promise<AgentRunResult> => ({
            exitCode: 0,
            raw: [],
            report: { status: "done", summary: "ok" },
            stream: { assistantText: "", toolCalls: [] },
            timedOut: false,
        }),
    };
}

describe("watchTick quarantine notification", () => {
    it("fires notifier with failed reason when attempts reach the dead-letter threshold (3)", async () => {
        const tracker = new WatchTracker({ inReview: [], todo: [] });
        const { fs } = memRunsFs();
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

        const { events, notifier } = spyNotifier();
        const out = await watchTick(
            "CG",
            watchDeps({
                driver: fakeWatchDriver(),
                notify: notifier,
                runsFs: fs,
                tracker,
            }),
        );

        expect(out.action).toBe("quarantined");
        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("failed");
        expect(events[0]!.key).toBe("CG-5");
    });

    it("does NOT fire notifier on a normal resume (attempts < 3)", async () => {
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

        const { events, notifier } = spyNotifier();
        const out = await watchTick(
            "CG",
            watchDeps({
                driver: fakeWatchDriver(),
                notify: notifier,
                runsFs: fs,
                tracker,
            }),
        );

        expect(out.action).toBe("resumed");
        expect(events).toHaveLength(0);
    });

    it("runIssue re-dispatched from watchTick forwards the notifier and fires on escalation", async () => {
        // Verify that runIssueDeps in watch.ts forwards deps.notify into RunIssueDeps
        // so a crash-resumed runIssue also notifies.
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

        const { events, notifier } = spyNotifier();
        // Driver returns needs_input → runIssue should fire the notifier
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => ({
                exitCode: 0,
                raw: [],
                report: { status: "needs_input", summary: "Needs guidance" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            }),
        };

        const out = await watchTick(
            "CG",
            watchDeps({
                driver,
                notify: notifier,
                runsFs: fs,
                tracker,
            }),
        );

        expect(out.action).toBe("resumed");
        expect(events).toHaveLength(1);
        expect(events[0]!.reason).toBe("needs_input");
        expect(events[0]!.key).toBe("CG-5");
    });
});
