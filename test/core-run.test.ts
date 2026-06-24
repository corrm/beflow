import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { Usage } from "../src/agent/events.ts";
import type { Report } from "../src/agent/report.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import { buildDecisionEvent, resolveDecisionsDir } from "../src/core/decisionlog.ts";
import type { DecisionEvent, DecisionSink } from "../src/core/decisionlog.ts";
import type { McpFs, McpServer } from "../src/core/mcp.ts";
import type { NotifyEvent } from "../src/core/notify.ts";
import type { PolicyExec } from "../src/core/policy.ts";
import { PREFLIGHT_BLOCK_MESSAGE } from "../src/core/preflight.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import type { GateExec } from "../src/core/qualitygate.ts";
import {
    buildInteractiveArgs,
    defaultOpenIssue,
    OPEN_SESSION_TRAILER,
    projectKeyOf,
    resolveRun,
    runIssue,
    runOpen,
    runSupervised,
} from "../src/core/run.ts";
import type {
    InteractiveLaunch,
    OpenLaunch,
    OutcomeContext,
    RunIssueDeps,
    RunOpenDeps,
    RunSupervisedDeps,
} from "../src/core/run.ts";
import type { Clock, RunRecord, RunStoreFs } from "../src/core/runstore.ts";
import { runRecordSchema, saveRecord } from "../src/core/runstore.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";
import type { ChangeReceipt, Issue, IssueMeta, PolicyDecision } from "../src/model/types.ts";
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

const config: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "supervised",
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

type TrackerCall =
    | { kind: "updateState"; key: string; state: string }
    | { kind: "assign"; key: string; assignee: string }
    | { kind: "addProperty"; key: string; label: string }
    | { kind: "removeProperty"; key: string; label: string }
    | { kind: "comment"; key: string; body: string }
    | { kind: "linkPR"; key: string; url: string };

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

class FakeTracker implements Tracker {
    calls: TrackerCall[] = [];
    // Mirrors the real board: once beflow moves the card to In Progress (or it
    // Started already), subsequent getIssue reads report a started-group state, so
    // The end-of-run re-read does NOT see a manual pull in the normal flow.
    private movedToInProgress = false;
    constructor(
        private readonly issue: Issue,
        private readonly comments: Comment[] = [],
    ) {
        this.movedToInProgress = issue.state.group === "started";
    }

    getIssueCalls = 0;
    async getIssue(): Promise<Issue> {
        this.getIssueCalls += 1;
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
    async listQueue(_f: QueueFilter): Promise<Issue[]> {
        return [];
    }
    async updateState(issue: Issue, stateName: string): Promise<void> {
        this.calls.push({ key: issue.key, kind: "updateState", state: stateName });
        if (stateName === "In Progress") {
            this.movedToInProgress = true;
        }
    }
    async assign(issue: Issue, assigneeId: string): Promise<void> {
        this.calls.push({ assignee: assigneeId, key: issue.key, kind: "assign" });
    }
    async addProperty(issue: Issue, name: string): Promise<void> {
        this.calls.push({ key: issue.key, kind: "addProperty", label: name });
    }
    async removeProperty(issue: Issue, name: string): Promise<void> {
        this.calls.push({ key: issue.key, kind: "removeProperty", label: name });
    }
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(issue: Issue, body: string): Promise<void> {
        this.calls.push({ body, key: issue.key, kind: "comment" });
    }
    async listComments(): Promise<Comment[]> {
        return this.comments;
    }
    async linkPR(issue: Issue, url: string): Promise<void> {
        this.calls.push({ key: issue.key, kind: "linkPR", url });
    }
    readMetadata(issue: Issue): IssueMeta {
        return issue.meta;
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return {
            labels: ["blocked", "triaged"],
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
    async findProjectId(): Promise<string | null> {
        return null;
    }
}

interface EnsureCall {
    sessionName: string;
    cwd: string;
    acpCommand: string;
}

function fakeDriver(report: Report | null): {
    driver: AgentDriver;
    seen: RunOptions[];
    ensured: EnsureCall[];
    order: string[];
} {
    const seen: RunOptions[] = [];
    const ensured: EnsureCall[] = [];
    const order: string[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async (sessionName: string, cwd: string, acpCommand: string): Promise<void> => {
            ensured.push({ acpCommand, cwd, sessionName });
            order.push("ensure");
        },
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            order.push("run");
            return {
                exitCode: 0,
                raw: [],
                report,
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };
    return { driver, ensured, order, seen };
}

// A driver that models a hard wall-clock timeout: the run was killed past its
// Deadline before the agent emitted a report (timedOut true, report null).
function timedOutDriver(): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            return {
                exitCode: 143,
                raw: [],
                report: null,
                stream: { assistantText: "", toolCalls: [] },
                timedOut: true,
            };
        },
    };
    return { driver, seen };
}

// A driver that models an agent crash: the process exited non-zero and/or the ACP
// Stream carried an error, yet emitted no report and did not time out.
function crashedDriver(opts: { exitCode: number; error?: { code?: number; message: string } }): {
    driver: AgentDriver;
    seen: RunOptions[];
} {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (runOpts: RunOptions): Promise<AgentRunResult> => {
            seen.push(runOpts);
            return {
                exitCode: opts.exitCode,
                raw: [],
                report: null,
                stream: {
                    assistantText: "",
                    toolCalls: [],
                    ...(opts.error !== undefined ? { error: opts.error } : {}),
                },
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

const fixedClock: Clock = () => "2026-06-14T00:00:00.000Z";

// A tracker whose FIRST getIssue (resolveRun + In Progress decision) reports a
// Started issue, and every subsequent read (the end-of-run re-read) reports a
// Caller-chosen state, so a manual move out of the started group can be simulated
// At the writeback re-read in runOpen / runSupervised.
class FlipReadTracker extends FakeTracker {
    private reads = 0;
    constructor(private readonly afterState: Issue["state"]) {
        super(
            makeIssue({
                meta: { jobKind: "implement", runMode: "autonomous" },
                state: { group: "started", name: "In Progress" },
            }),
        );
    }
    override async getIssue(): Promise<Issue> {
        this.reads += 1;
        const base = makeIssue({
            meta: { jobKind: "implement", runMode: "autonomous" },
            state: { group: "started", name: "In Progress" },
        });
        if (this.reads === 1) {
            return base;
        }
        return { ...base, state: this.afterState };
    }
}

function onlyRecord(store: Map<string, string>): RunRecord | null {
    // Run records are <key>.json; the decision log is a sibling .ndjson, so it is
    // Filtered out here — this helper asserts on the single run record only.
    const values = [...store.entries()].filter(([path]) => path.endsWith(".json")).map(([, value]) => value);
    return values.length === 1 ? runRecordSchema.parse(JSON.parse(values[0]!)) : null;
}

function fakeGit(): { git: Exec; calls: string[][] } {
    const calls: string[][] = [];
    const git: Exec = async (cmd, args): Promise<ExecResult> => {
        calls.push([cmd, ...args]);
        return { code: 0, stderr: "", stdout: "" };
    };
    return { calls, git };
}

function memMcpFs(): { fs: McpFs; store: Map<string, string> } {
    const store = new Map<string, string>();
    const fs: McpFs = {
        exists: (p) => store.has(p),
        read: (p) => store.get(p) ?? "",
        remove: (p) => {
            store.delete(p);
        },
        write: (p, data) => {
            store.set(p, data);
        },
    };
    return { fs, store };
}

const mcpServers: McpServer[] = [{ args: [], command: "bunx", env: [], name: "codegraph" }];

function capturingSink(): { sink: DecisionSink; events: DecisionEvent[] } {
    const events: DecisionEvent[] = [];
    const sink: DecisionSink = {
        emit: async (event) => {
            events.push(event);
        },
    };
    return { events, sink };
}

describe("projectKeyOf", () => {
    it("extracts the project key from a valid issue key", () => {
        expect(projectKeyOf("PROJ-123")).toBe("PROJ");
    });

    it("handles multi-segment keys", () => {
        expect(projectKeyOf("MY-PROJ-42")).toBe("MY-PROJ");
    });

    it("throws on a key without a dash", () => {
        expect(() => projectKeyOf("NODESH")).toThrow(
            /malformed issue key "NODESH"/,
        );
    });
});

describe("resolveRun", () => {
    it("throws on an unknown project key before any tracker call", async () => {
        const tracker = new FakeTracker(makeIssue({ key: "ZZ-1" }));
        expect(resolveRun("ZZ-1", {}, config, registry, tracker)).rejects.toThrow(
            /unknown project "ZZ" \(known: .*\) — run `beflow setup ZZ`/,
        );
        expect(tracker.getIssueCalls).toBe(0);
    });

    it("resolves issue, project, and resolved fields", async () => {
        const tracker = new FakeTracker(makeIssue());
        const out = await resolveRun("CG-42", {}, config, registry, tracker);
        expect(out.issue.key).toBe("CG-42");
        expect(out.project.name).toBe("My App");
        expect(out.resolved.repoPath).toBe("/repo/bin");
    });
});

describe("runIssue", () => {
    function deps(over: Partial<RunIssueDeps> & { tracker: Tracker; driver: AgentDriver }): RunIssueDeps {
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

    it("moves to In Progress, ensures the session, runs persistently, applies the report", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen, ensured, order } = fakeDriver({
            prUrl: "http://pr/1",
            status: "done",
            summary: "fixed",
        });
        const result = await runIssue("CG-42", {}, deps({ driver, tracker }));

        expect(seen[0]!.runMode).toBe("autonomous");
        expect(seen[0]!.nonInteractive).toBe("fail");
        // Persistent, resumable session — NOT one-shot exec.
        expect(seen[0]!.oneShot).toBeFalsy();
        expect(seen[0]!.cwd).toBe("/repo/bin");
        expect(result.applied).toEqual({ movedTo: "In Review" });

        // EnsureSession runs before the prompt, with (key, cwd, acpCommand).
        expect(ensured).toEqual([{ acpCommand: "claude", cwd: "/repo/bin", sessionName: "CG-42" }]);
        expect(order).toEqual(["ensure", "run"]);

        const states = tracker.calls.filter((c) => c.kind === "updateState");
        expect(states[0]).toEqual({
            key: "CG-42",
            kind: "updateState",
            state: "In Progress",
        });
    });

    it("passes the resolved agent acpCommand to both ensureSession and run", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen, ensured } = fakeDriver({ status: "done", summary: "s" });
        const cfg: Config = {
            ...config,
            agents: { claude: { command: "claude-acp" } },
        };
        await runIssue("CG-42", {}, deps({ config: cfg, driver, tracker }));

        expect(ensured[0]!.acpCommand).toBe("claude-acp");
        expect(seen[0]!.acpCommand).toBe("claude-acp");
    });

    it("prefers acpCommand and joins acpArgs for the resolved agent", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen, ensured } = fakeDriver({ status: "done", summary: "s" });
        const cfg: Config = {
            ...config,
            agents: { claude: { acpArgs: ["x"], acpCommand: "npx", command: "claude" } },
        };
        await runIssue("CG-42", {}, deps({ config: cfg, driver, tracker }));

        expect(ensured[0]!.acpCommand).toBe("npx x");
        expect(seen[0]!.acpCommand).toBe("npx x");
    });

    it("throws when the resolved agent is not configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "done", summary: "s" });
        const cfg: Config = { ...config, agents: {} };
        expect(runIssue("CG-42", {}, deps({ config: cfg, driver, tracker }))).rejects.toThrow(
            /agent "claude" is not configured/,
        );
    });

    it("assigns the configured user after moving to In Progress", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "done", summary: "s" });
        const cfg: Config = { ...config, assignee: "u-1" };
        await runIssue("CG-42", {}, deps({ config: cfg, driver, tracker }));

        const moveIdx = tracker.calls.findIndex((c) => c.kind === "updateState" && c.state === "In Progress");
        const assignIdx = tracker.calls.findIndex((c) => c.kind === "assign");
        expect(assignIdx).toBeGreaterThan(moveIdx);
        expect(tracker.calls).toContainEqual({
            assignee: "u-1",
            key: "CG-42",
            kind: "assign",
        });
    });

    it("does not assign when no assignee is configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver({ status: "done", summary: "s" });
        await runIssue("CG-42", {}, deps({ driver, tracker }));
        expect(tracker.calls.some((c) => c.kind === "assign")).toBe(false);
    });

    it("skips the In Progress move when already in the started group", async () => {
        const tracker = new FakeTracker(makeIssue({ state: { group: "started", name: "In Progress" } }));
        const { driver } = fakeDriver({ status: "failed", summary: "x" });
        await runIssue("CG-42", {}, deps({ driver, tracker }));
        const toInProgress = tracker.calls.filter((c) => c.kind === "updateState" && c.state === "In Progress");
        expect(toInProgress).toHaveLength(0);
    });

    it("on a spec/triage done report: removes the worktree and deletes the record", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { jobKind: "triage", runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const result = await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(result.cwd).toBe("/wt/cg-42");
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
        expect(calls.some((c) => c.includes("add"))).toBe(true);
        expect(calls.some((c) => c.includes("remove"))).toBe(true);
        expect(store.size).toBe(0);
    });

    it("on an implement done report: keeps the worktree and the record with the PR and report", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const result = await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(result.cwd).toBe("/wt/cg-42");
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        const rec = onlyRecord(store);
        expect(rec?.status).toBe("done");
        expect(rec?.prUrl).toBe("http://pr/7");
        expect(rec?.report).toEqual({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
    });

    it("on an implement done report: posts the In-Review instruction comment", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }));
        const { driver } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        const sentinel = "To request changes: add the `changes-requested` label";
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes(sentinel))).toBe(true);
    });

    it("does not re-post the In-Review instruction when a bot comment with the sentinel exists", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }), [
            {
                body: "Already In Review. To request changes: add the `changes-requested` label and comment.",
                createdAt: "2026-06-01T00:00:00.000Z",
                id: "c-prev",
                isBot: true,
            },
        ]);
        const { driver } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        const sentinel = "To request changes: add the `changes-requested` label";
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes(sentinel))).toBe(false);
    });

    it("threads a provided continuation into the task ahead of the base task", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        await runIssue("CG-42", {}, deps({ continuation: "ADDRESS THIS FEEDBACK", driver, tracker }));
        expect(seen[0]!.task).toContain("ADDRESS THIS FEEDBACK");
        expect(seen[0]!.task.startsWith("ADDRESS THIS FEEDBACK")).toBe(true);
    });

    it("on a failed report: keeps the worktree and the record with status", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = fakeDriver({ status: "failed", summary: "x" });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(calls.some((c) => c.includes("add"))).toBe(true);
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("failed");
    });

    it("passes the resolved maxRunMinutes (project limit) as timeoutSeconds to the driver", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const reg: Registry = {
            ...registry,
            projects: { ...registry.projects, CG: { ...registry.projects.CG!, limits: { maxRunMinutes: 12 } } },
        };
        await runIssue("CG-42", {}, deps({ driver, registry: reg, tracker }));
        expect(seen[0]!.timeoutSeconds).toBe(12 * 60);
    });

    it("passes no timeoutSeconds to the driver when no project limit is configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        await runIssue("CG-42", {}, deps({ driver, tracker }));
        expect(seen[0]!.timeoutSeconds).toBeUndefined();
    });

    function usageDriver(report: Report | null, usage: Usage): AgentDriver {
        return {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => ({
                exitCode: 0,
                raw: [],
                report,
                stream: { assistantText: "", toolCalls: [], usage },
                timedOut: false,
            }),
        };
    }

    function telemetryConfig(inComment: boolean): Config {
        return {
            ...config,
            agents: { claude: { command: "claude", model: "sonnet" } },
            telemetry: { inComment },
        };
    }

    describe("telemetry", () => {
        it("persists usage on the terminal record (implement done)", async () => {
            const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
            const driver = usageDriver(
                { prUrl: "http://pr/1", status: "done", summary: "s" },
                { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
            );
            const { fs, store } = memRunsFs();
            await runIssue("CG-42", {}, deps({ driver, runsFs: fs, tracker }));
            expect(onlyRecord(store)?.usage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
        });

        it("persists usage on a non-done terminal record", async () => {
            const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
            const driver = usageDriver({ status: "needs_input", summary: "q" }, { totalTokens: 77 });
            const { fs, store } = memRunsFs();
            await runIssue("CG-42", {}, deps({ driver, runsFs: fs, tracker }));
            expect(onlyRecord(store)?.usage).toEqual({ totalTokens: 77 });
        });

        it("appends the telemetry line to the comment when inComment is on and usage exists", async () => {
            const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
            const driver = usageDriver({ status: "done", summary: "s" }, { costUsd: 0.05, totalTokens: 140 });
            await runIssue("CG-42", {}, deps({ config: telemetryConfig(true), driver, tracker }));
            const comment = tracker.calls.find(
                (c): c is Extract<(typeof tracker.calls)[number], { kind: "comment" }> => c.kind === "comment",
            );
            expect(comment?.body).toContain("beflow: 140 tok · model sonnet");
            expect(comment?.body).toContain("~$0.0500");
        });

        it("does NOT append the telemetry line when inComment is off", async () => {
            const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
            const driver = usageDriver({ status: "done", summary: "s" }, { totalTokens: 140 });
            await runIssue("CG-42", {}, deps({ config: telemetryConfig(false), driver, tracker }));
            expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("beflow: 140 tok"))).toBe(false);
        });

        it("does NOT append the telemetry line when usage is absent (even if inComment is on)", async () => {
            const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
            const { driver } = fakeDriver({ status: "done", summary: "s" });
            await runIssue("CG-42", {}, deps({ config: telemetryConfig(true), driver, tracker }));
            expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("beflow:"))).toBe(false);
        });
    });

    it("on a hard timeout with no report: parks as failed (Needs Input + failed label + timeout comment + escalation)", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = timedOutDriver();
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const events: NotifyEvent[] = [];
        const reg: Registry = {
            ...registry,
            projects: { ...registry.projects, CG: { ...registry.projects.CG!, limits: { maxRunMinutes: 30 } } },
        };
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                git,
                notify: {
                    notify: async (evt: NotifyEvent): Promise<void> => {
                        events.push(evt);
                    },
                },
                registry: reg,
                runsFs: fs,
                tracker,
            }),
        );

        // Moved to Needs Input, got the failed label, kept the worktree, saved failed.
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("timed out after 30 minutes"))).toBe(
            true,
        );
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("failed");
        // Escalation fired with the failed reason.
        expect(events.some((e) => e.reason === "failed")).toBe(true);
    });

    it("on a hard timeout but a human moved the card: yields (no park, no failed writeback)", async () => {
        const tracker = new FlipReadTracker({ group: "cancelled", name: "Cancelled" });
        const { driver } = timedOutDriver();
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const reg: Registry = {
            ...registry,
            projects: { ...registry.projects, CG: { ...registry.projects.CG!, limits: { maxRunMinutes: 30 } } },
        };
        const result = await runIssue("CG-42", {}, deps({ driver, git, registry: reg, runsFs: fs, tracker }));

        // No failed writeback (no Needs Input move, no failed label).
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(false);
        expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(false);
        // The synthesized timeout summary is preserved as a comment, worktree removed,
        // Record deleted, nothing applied — the human's move stands.
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("timed out after 30 minutes"))).toBe(
            true,
        );
        expect(calls.some((c) => c.includes("remove"))).toBe(true);
        expect(store.size).toBe(0);
        expect(result.applied).toBeUndefined();
    });

    it("on a hard timeout that still emitted a report: honors that report, not the synthesized one", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => ({
                exitCode: 0,
                raw: [],
                report: { status: "needs_input", summary: "I have a question" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: true,
            }),
        };
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(onlyRecord(store)?.status).toBe("needs_input");
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("I have a question"))).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("timed out"))).toBe(false);
    });

    it("on a needs_input report: persists the report and prUrl in the record", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = fakeDriver({ prUrl: "http://pr/99", status: "needs_input", summary: "waiting" });
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        const rec = onlyRecord(store);
        expect(rec?.status).toBe("needs_input");
        expect(rec?.report).toEqual({ prUrl: "http://pr/99", status: "needs_input", summary: "waiting" });
        expect(rec?.prUrl).toBe("http://pr/99");
    });

    it("on no report: keeps the worktree and the in_progress record", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = fakeDriver(null);
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("in_progress");
    });

    it("on a crash with no report (non-zero exit): parks as failed (Needs Input + failed label + escalation)", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = crashedDriver({ exitCode: 1 });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const events: NotifyEvent[] = [];
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                git,
                notify: {
                    notify: async (evt: NotifyEvent): Promise<void> => {
                        events.push(evt);
                    },
                },
                runsFs: fs,
                tracker,
            }),
        );

        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("crashed (exit code 1)"))).toBe(true);
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("failed");
        expect(events.some((e) => e.reason === "failed")).toBe(true);
    });

    it("on a crash with no report (exit 0 but ACP stream error): parks as failed", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = crashedDriver({ error: { message: "boom" }, exitCode: 0 });
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        const events: NotifyEvent[] = [];
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                git,
                notify: {
                    notify: async (evt: NotifyEvent): Promise<void> => {
                        events.push(evt);
                    },
                },
                runsFs: fs,
                tracker,
            }),
        );

        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("crashed (stream error: boom)"))).toBe(
            true,
        );
        expect(onlyRecord(store)?.status).toBe("failed");
        expect(events.some((e) => e.reason === "failed")).toBe(true);
    });

    it("on a clean empty run (no report, exit 0, no stream error): keeps the worktree and in_progress record", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = crashedDriver({ exitCode: 0 });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(false);
        expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(false);
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("in_progress");
    });

    it("keeps the worktree and in_progress record when the agent run throws", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => {
                throw new Error("agent exploded");
            },
        };
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        expect(runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }))).rejects.toThrow(/agent exploded/);
        expect(calls.some((c) => c.includes("remove"))).toBe(false);
        expect(onlyRecord(store)?.status).toBe("in_progress");
    });

    it("resumes a prior in_progress record without creating a new worktree", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver, seen, ensured } = fakeDriver({ status: "failed", summary: "x" });
        const { git, calls } = fakeGit();
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                git,
                pathExists: (p) => p === "/wt/cg-42",
                runsFs: fs,
                tracker,
            }),
        );

        expect(calls.some((c) => c.includes("add"))).toBe(false);
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
        expect(ensured[0]).toEqual({
            acpCommand: "claude",
            cwd: "/wt/cg-42",
            sessionName: "CG-42",
        });
        expect(seen[0]!.task).toContain("Resuming work item CG-42");
        expect(store.size).toBe(1);
    });

    it("resume freezes agent/jobKind/repoPath to the prior record, not live config", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        const prior: RunRecord = {
            agent: "gemini",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            jobKind: "triage",
            key: "CG-42",
            repoPath: "/old/repo",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            tracker: "plane",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver, seen, ensured } = fakeDriver({ status: "done", summary: "s" });
        const { git, calls } = fakeGit();
        const cfg: Config = {
            ...config,
            agents: { claude: { command: "claude" }, gemini: { command: "gemini-acp" } },
        };
        await runIssue(
            "CG-42",
            {},
            deps({
                config: cfg,
                driver,
                git,
                pathExists: (p) => p === "/wt/cg-42",
                runsFs: fs,
                tracker,
            }),
        );

        // The RECORD's agent drives the acpCommand, not the resolved 'claude'.
        expect(ensured[0]!.acpCommand).toBe("gemini-acp");
        expect(seen[0]!.acpCommand).toBe("gemini-acp");
        // The RECORD's jobKind drives the writeback (triage moves to a different state).
        // RemoveWorktree on a done report uses the record's repoPath, not resolved.
        const removeCall = calls.find((c) => c.includes("remove"));
        expect(removeCall).toEqual(["git", "-C", "/old/repo", "worktree", "remove", "/wt/cg-42", "--force"]);
        expect(store.size).toBe(0);
    });

    it("skips a resume when the record tracker mismatches live config", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            tracker: "linear",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        expect(
            runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    pathExists: (p) => p === "/wt/cg-42",
                    runsFs: fs,
                    tracker,
                }),
            ),
        ).rejects.toThrow(/was started under tracker/);
        // No tracker writes happened before the throw.
        expect(tracker.calls).toHaveLength(0);
    });

    it("resumes normally when the prior record has no tracker field", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver, seen } = fakeDriver({ status: "failed", summary: "x" });
        const { git } = fakeGit();
        expect(
            runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    pathExists: (p) => p === "/wt/cg-42",
                    runsFs: fs,
                    tracker,
                }),
            ),
        ).resolves.toBeDefined();
        expect(seen[0]!.task).toContain("Resuming work item CG-42");
    });

    it("a fresh run record carries tracker and repoPath", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = fakeDriver({ status: "failed", summary: "x" });
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        const rec = onlyRecord(store);
        expect(rec?.tracker).toBe("plane");
        expect(rec?.repoPath).toBe("/repo/bin");
    });

    it("--fresh discards a prior record and creates a new worktree", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver, seen } = fakeDriver({ status: "failed", summary: "x" });
        const { git, calls } = fakeGit();
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                fresh: true,
                git,
                pathExists: () => true,
                runsFs: fs,
                tracker,
            }),
        );

        // Best-effort removal of the prior worktree, then a fresh add.
        expect(calls.some((c) => c.includes("add"))).toBe(true);
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
        expect(seen[0]!.task).not.toContain("Resuming");
    });

    it("--fresh warns but still proceeds when the prior worktree removal fails", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const calls: string[][] = [];
        const git: Exec = async (cmd, args): Promise<ExecResult> => {
            calls.push([cmd, ...args]);
            if (args.includes("remove")) {
                return { code: 1, stderr: "worktree is locked", stdout: "" };
            }
            return { code: 0, stderr: "", stdout: "" };
        };
        const logs: string[] = [];
        const { driver, seen } = fakeDriver({ status: "failed", summary: "x" });
        await runIssue(
            "CG-42",
            {},
            deps({
                driver,
                fresh: true,
                git,
                log: (m) => {
                    logs.push(m);
                },
                pathExists: () => true,
                runsFs: fs,
                tracker,
            }),
        );

        expect(logs.some((m) => m.startsWith("beflow: warning — could not remove worktree at /wt/cg-42:"))).toBe(true);
        expect(logs.some((m) => m.includes("worktree is locked"))).toBe(true);
        // The failed removal does not block the fresh run: the worktree is re-added.
        expect(calls.some((c) => c.includes("add"))).toBe(true);
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
        expect(seen[0]!.task).not.toContain("Resuming");
    });

    it("--fresh re-creates the worktree with -B even when the branch already exists", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        // Prior interrupted run left the worktree record AND a beflow/cg-42 branch.
        const prior: RunRecord = {
            agent: "claude",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            key: "CG-42",
            jobKind: "implement",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);

        const { driver, seen } = fakeDriver({ status: "failed", summary: "x" });
        const { git, calls } = fakeGit();
        expect(
            runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    fresh: true,
                    git,
                    pathExists: () => true,
                    runsFs: fs,
                    tracker,
                }),
            ),
        ).resolves.toBeDefined();

        // (a) the prior worktree is removed before the fresh add.
        const removeIdx = calls.findIndex((c) => c.includes("remove"));
        const addIdx = calls.findIndex((c) => c.includes("add"));
        expect(removeIdx).toBeGreaterThanOrEqual(0);
        expect(removeIdx).toBeLessThan(addIdx);
        expect(calls[removeIdx]).toEqual(["git", "-C", "/repo/bin", "worktree", "remove", "/wt/cg-42", "--force"]);
        // (b) createWorktree is invoked again with -B (create-or-reset the branch),
        // Which is idempotent against the leftover beflow/cg-42 branch.
        expect(calls[addIdx]).toEqual(["git", "-C", "/repo/bin", "worktree", "add", "-B", "beflow/cg-42", "/wt/cg-42"]);
        expect(seen[0]!.cwd).toBe("/wt/cg-42");
    });

    it("does not create a worktree when git is absent", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const result = await runIssue("CG-42", {}, deps({ driver, tracker }));
        expect(result.cwd).toBe("/repo/bin");
        expect(seen[0]!.cwd).toBe("/repo/bin");
    });

    it("leaves the issue In Progress when no report is produced", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver(null);
        const result = await runIssue("CG-42", {}, deps({ driver, tracker }));
        expect(result.applied).toBeUndefined();
        expect(tracker.calls.some((c) => c.kind === "comment")).toBe(false);
    });

    it("record-first: writes the run record before the first board move", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { driver } = fakeDriver(null); // no report → leaves the in_progress record in place
        const { fs } = memRunsFs();
        const order: string[] = [];
        const spyFs: RunStoreFs = {
            append: (path, data) => {
                fs.append(path, data);
            },
            list: (dir) => fs.list(dir),
            read: (path) => fs.read(path),
            remove: (path) => {
                fs.remove(path);
            },
            write: (path, data) => {
                order.push("write");
                fs.write(path, data);
            },
        };
        // Patch updateState to record its position in the shared order array.
        const realUpdateState = tracker.updateState.bind(tracker);
        tracker.updateState = async (i, s): Promise<void> => {
            order.push("updateState");
            await realUpdateState(i, s);
        };
        await runIssue("CG-42", {}, deps({ driver, runsFs: spyFs, tracker }));
        expect(order.indexOf("write")).toBeGreaterThanOrEqual(0);
        expect(order.indexOf("write")).toBeLessThan(order.indexOf("updateState"));
    });

    it("attempts: a fresh dispatch saves attempts 0", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver } = fakeDriver(null);
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));
        expect(onlyRecord(store)?.attempts).toBe(0);
    });

    it("attempts: a crash resume (prior in_progress, no continuation) increments attempts", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 1,
                branch: "beflow/cg-42",
                cwd: "/wt/cg-42",
                key: "CG-42",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-42",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver(null); // no report → keeps the in_progress record
        const { git } = fakeGit();
        await runIssue("CG-42", {}, deps({ driver, git, pathExists: (p) => p === "/wt/cg-42", runsFs: fs, tracker }));
        expect(onlyRecord(store)?.attempts).toBe(2);
    });

    it("attempts: a re-dispatch WITH a continuation resets attempts to 0", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 2,
                branch: "beflow/cg-42",
                cwd: "/wt/cg-42",
                key: "CG-42",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-42",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver(null);
        const { git } = fakeGit();
        await runIssue(
            "CG-42",
            {},
            deps({
                continuation: "ADDRESS THIS",
                driver,
                git,
                pathExists: (p) => p === "/wt/cg-42",
                runsFs: fs,
                tracker,
            }),
        );
        expect(onlyRecord(store)?.attempts).toBe(0);
    });

    it("attempts: a clean needs_input completion resets attempts to 0", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 2,
                branch: "beflow/cg-42",
                cwd: "/wt/cg-42",
                key: "CG-42",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-42",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver({ status: "needs_input", summary: "waiting" });
        const { git } = fakeGit();
        await runIssue("CG-42", {}, deps({ driver, git, pathExists: (p) => p === "/wt/cg-42", runsFs: fs, tracker }));
        const rec = onlyRecord(store);
        expect(rec?.status).toBe("needs_input");
        expect(rec?.attempts).toBe(0);
    });

    it("attempts: a clean implement-done completion resets attempts to 0", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }));
        const { fs, store } = memRunsFs();
        saveRecord(
            "/runs",
            {
                agent: "claude",
                attempts: 2,
                branch: "beflow/cg-42",
                cwd: "/wt/cg-42",
                key: "CG-42",
                jobKind: "implement",
                runMode: "autonomous",
                sessionName: "CG-42",
                status: "in_progress",
                updatedAt: "2026-01-01T00:00:00.000Z",
            },
            fs,
        );
        const { driver } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
        const { git } = fakeGit();
        await runIssue("CG-42", {}, deps({ driver, git, pathExists: (p) => p === "/wt/cg-42", runsFs: fs, tracker }));
        const rec = onlyRecord(store);
        expect(rec?.status).toBe("done");
        expect(rec?.attempts).toBe(0);
    });

    // A tracker whose getIssue returns a started issue first (resolve + In Progress
    // Move) and a controllable state on every subsequent read (the writeback re-read
    // And any poller reads), so a manual move can be simulated mid/post run.
    class FlipTracker extends FakeTracker {
        private reads = 0;
        constructor(
            private readonly afterState: Issue["state"],
            comments: Comment[] = [],
        ) {
            super(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }), comments);
        }
        override async getIssue(): Promise<Issue> {
            this.reads += 1;
            const base = makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } });
            if (this.reads === 1) {
                return base;
            }
            return { ...base, state: this.afterState };
        }
    }

    it("YIELD: a manual move to cancelled skips writeback, comments, and cleans up", async () => {
        const tracker = new FlipTracker({ group: "cancelled", name: "Cancelled" });
        const { driver, seen } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "agent did work" });
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const result = await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        // The run still happened.
        expect(seen).toHaveLength(1);
        // No writeback state move to In Review (the implement done target).
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
        // The agent's summary was preserved as a comment.
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("agent did work"))).toBe(true);
        // The worktree was removed and the record deleted.
        expect(calls.some((c) => c.includes("remove"))).toBe(true);
        expect(store.size).toBe(0);
        // No applied writeback is returned.
        expect(result.applied).toBeUndefined();
    });

    it("NORMAL: a started issue at the re-read applies the report unchanged", async () => {
        const tracker = new FlipTracker({ group: "started", name: "In Progress" });
        const { driver } = fakeDriver({ prUrl: "http://pr/7", status: "done", summary: "shipped" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        const result = await runIssue("CG-42", {}, deps({ driver, git, runsFs: fs, tracker }));

        expect(result.applied).toEqual({ movedTo: "In Review" });
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(true);
    });

    it("ABORT: cancels the agent mid-run on a manual move, then yields", async () => {
        const tracker = new FlipTracker({ group: "cancelled", name: "Cancelled" });
        const cancelCalls: { sessionKey: string; cwd: string; acpCommand: string }[] = [];
        // The run blocks until cancel fires; cancel resolves it. No real timers.
        let resolveRun: (() => void) | undefined;
        const blocked = new Promise<void>((r) => {
            resolveRun = r;
        });
        const seen: RunOptions[] = [];
        const driver: AgentDriver = {
            cancel: async (sessionKey, cwd, acpCommand): Promise<void> => {
                cancelCalls.push({ acpCommand, cwd, sessionKey });
                resolveRun?.();
            },
            ensureSession: async () => {},
            run: async (opts): Promise<AgentRunResult> => {
                seen.push(opts);
                await blocked;
                return {
                    exitCode: 0,
                    raw: [],
                    report: { status: "done", summary: "s" },
                    stream: { assistantText: "", toolCalls: [] },
                    timedOut: false,
                };
            },
        };
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        const abortCfg: Config = { ...config, onManualMove: "abort" };
        const result = await runIssue(
            "CG-42",
            {},
            deps({
                config: abortCfg,
                driver,
                git,
                manualMovePollMs: 1,
                runsFs: fs,
                sleep: async () => {},
                tracker,
            }),
        );

        expect(cancelCalls).toHaveLength(1);
        expect(cancelCalls[0]).toEqual({ acpCommand: "claude", cwd: "/wt/cg-42", sessionKey: "CG-42" });
        // The run yields: no writeback, record cleaned up.
        expect(result.applied).toBeUndefined();
        expect(seen).toHaveLength(1);
        expect(store.size).toBe(0);
    });

    it("ABORT disabled (yield mode): never cancels even if the state flips, but still yields", async () => {
        const tracker = new FlipTracker({ group: "cancelled", name: "Cancelled" });
        let cancelled = false;
        const driver: AgentDriver = {
            cancel: async (): Promise<void> => {
                cancelled = true;
            },
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => ({
                exitCode: 0,
                raw: [],
                report: { status: "done", summary: "s" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            }),
        };
        const { git } = fakeGit();
        const { fs, store } = memRunsFs();
        // config defaults to onManualMove "yield" — no poller is started.
        const result = await runIssue(
            "CG-42",
            {},
            deps({ driver, git, manualMovePollMs: 1, runsFs: fs, sleep: async () => {}, tracker }),
        );

        expect(cancelled).toBe(false);
        // The end-of-run re-read still yields.
        expect(result.applied).toBeUndefined();
        expect(store.size).toBe(0);
    });

    it("MCP: injects .acpxrc.json into the cwd before the run and restores it after", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs: mcpFs, store: mcpStore } = memMcpFs();
        const acpxPath = "/wt/cg-42/.acpxrc.json";
        // Capture what the file held WHILE the run was live (during driver.run).
        let duringRun: string | undefined;
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => {
                duringRun = mcpStore.get(acpxPath);
                return {
                    exitCode: 0,
                    raw: [],
                    report: { status: "done", summary: "shipped" },
                    stream: { assistantText: "", toolCalls: [] },
                    timedOut: false,
                };
            },
        };
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, mcpFs, mcpServers, runsFs: fs, tracker }));

        // The file existed during the run, carrying the injected mcpServers...
        expect(duringRun).toBeDefined();
        expect(JSON.parse(duringRun ?? "")).toEqual({ mcpServers });
        // ...and was restored (here: removed, since there was no prior file) after.
        expect(mcpStore.has(acpxPath)).toBe(false);
    });

    it("MCP: does not inject when no mcpServers are provided", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs: mcpFs, store: mcpStore } = memMcpFs();
        const { driver } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        await runIssue("CG-42", {}, deps({ driver, git, mcpFs, runsFs: fs, tracker }));
        expect(mcpStore.size).toBe(0);
    });

    it("MCP: restores the .acpxrc.json even when the agent run throws", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { fs: mcpFs, store: mcpStore } = memMcpFs();
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (): Promise<AgentRunResult> => {
                throw new Error("agent exploded");
            },
        };
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        expect(runIssue("CG-42", {}, deps({ driver, git, mcpFs, mcpServers, runsFs: fs, tracker }))).rejects.toThrow(
            /agent exploded/,
        );
        // Cleanup ran in the finally: the throwaway file is gone.
        expect(mcpStore.has("/wt/cg-42/.acpxrc.json")).toBe(false);
    });

    // The input-quality gate fires only on a FRESH autonomous dispatch. The config here
    // Defaults to autonomous so resolveRun picks runMode "autonomous" for the issue.
    const autonomousConfig: Config = { ...config, runMode: "autonomous" };

    function thinRegistry(min: number): Registry {
        return {
            ...registry,
            projects: { ...registry.projects, CG: { ...registry.projects.CG!, inputQuality: { minBodyChars: min } } },
        };
    }

    it("input-quality: a fresh autonomous dispatch of a thin issue parks to Needs Input without running the agent", async () => {
        const tracker = new FakeTracker(makeIssue({ body: "<p>thin</p>", meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver(null);
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const events: NotifyEvent[] = [];
        const result = await runIssue(
            "CG-42",
            {},
            deps({
                config: autonomousConfig,
                driver,
                git,
                notify: {
                    notify: async (evt: NotifyEvent): Promise<void> => {
                        events.push(evt);
                    },
                },
                registry: thinRegistry(50),
                runsFs: fs,
                tracker,
            }),
        );

        expect(result.parked).toBe("thin");
        // The agent never ran and no worktree was created.
        expect(seen).toHaveLength(0);
        expect(calls.some((c) => c.includes("add"))).toBe(false);
        // Moved to Needs Input with the guidance comment; no record was claimed.
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("too thin"))).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Progress")).toBe(false);
        expect(store.size).toBe(0);
        // Escalation fired as a needs_input event.
        expect(events.some((e) => e.reason === "needs_input")).toBe(true);
    });

    it("input-quality: a thin issue with the gate off (minBodyChars unset) dispatches normally", async () => {
        const tracker = new FakeTracker(makeIssue({ body: "<p>thin</p>", meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        const result = await runIssue(
            "CG-42",
            {},
            deps({ config: autonomousConfig, driver, git, runsFs: fs, tracker }),
        );

        expect(result.parked).toBeUndefined();
        expect(seen).toHaveLength(1);
    });

    it("input-quality: a continuation (rework) with a thin body is NOT parked", async () => {
        const tracker = new FakeTracker(makeIssue({ body: "<p>thin</p>", meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        const result = await runIssue(
            "CG-42",
            {},
            deps({
                config: autonomousConfig,
                continuation: "ADDRESS THIS FEEDBACK",
                driver,
                git,
                registry: thinRegistry(50),
                runsFs: fs,
                tracker,
            }),
        );

        expect(result.parked).toBeUndefined();
        expect(seen).toHaveLength(1);
    });

    it("input-quality: a resumable prior with a thin body is NOT parked", async () => {
        const tracker = new FakeTracker(makeIssue({ body: "<p>thin</p>", meta: { runMode: "autonomous" } }));
        const { fs } = memRunsFs();
        const prior: RunRecord = {
            agent: "claude",
            branch: "beflow/cg-42",
            cwd: "/wt/cg-42",
            jobKind: "implement",
            key: "CG-42",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "in_progress",
            updatedAt: "2026-01-01T00:00:00.000Z",
        };
        saveRecord("/runs", prior, fs);
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        const result = await runIssue(
            "CG-42",
            {},
            deps({
                config: autonomousConfig,
                driver,
                git,
                pathExists: (p) => p === "/wt/cg-42",
                registry: thinRegistry(50),
                runsFs: fs,
                tracker,
            }),
        );

        expect(result.parked).toBeUndefined();
        expect(seen).toHaveLength(1);
        expect(seen[0]!.task).toContain("Resuming work item CG-42");
    });

    it("decision-gate: a fresh autonomous dispatch of a needs-decision issue parks to Needs Input without running the agent", async () => {
        const tracker = new FakeTracker(makeIssue({ labels: ["needs-decision"], meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver(null);
        const { git, calls } = fakeGit();
        const { fs, store } = memRunsFs();
        const events: NotifyEvent[] = [];
        const result = await runIssue(
            "CG-42",
            {},
            deps({
                config: autonomousConfig,
                driver,
                git,
                notify: {
                    notify: async (evt: NotifyEvent): Promise<void> => {
                        events.push(evt);
                    },
                },
                runsFs: fs,
                tracker,
            }),
        );

        expect(result.parked).toBe("decision");
        // The agent never ran and no worktree was created.
        expect(seen).toHaveLength(0);
        expect(calls.some((c) => c.includes("add"))).toBe(false);
        // Moved to Needs Input with the hold comment; never moved to In Progress.
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("held for a human decision"))).toBe(
            true,
        );
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Progress")).toBe(false);
        // A hold record was written, tagged heldReason "decision" and status needs_input.
        const rec = onlyRecord(store);
        expect(rec?.heldReason).toBe("decision");
        expect(rec?.status).toBe("needs_input");
        // Escalation fired as a needs_input event.
        expect(events.some((e) => e.reason === "needs_input")).toBe(true);
    });

    it("decision-gate: an issue WITHOUT the needs-decision label dispatches normally", async () => {
        const tracker = new FakeTracker(makeIssue({ meta: { runMode: "autonomous" } }));
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const { git } = fakeGit();
        const { fs } = memRunsFs();
        const result = await runIssue(
            "CG-42",
            {},
            deps({ config: autonomousConfig, driver, git, runsFs: fs, tracker }),
        );

        expect(result.parked).toBeUndefined();
        expect(seen).toHaveLength(1);
    });

    describe("preflight", () => {
        // A registry whose CG project opts into a policy. The preflight reuses the SAME
        // resolvePolicy/evaluatePolicy as the post-diff gate (one resolver, two call
        // points), so a globs block here is what both layers see.
        function policyRegistry(policy: Registry["projects"]["CG"]["policy"]): Registry {
            return {
                ...registry,
                projects: {
                    ...registry.projects,
                    CG: { ...registry.projects.CG!, ...(policy !== undefined ? { policy } : {}) },
                },
            };
        }

        const declaringIssue = (body: string): Issue =>
            makeIssue({ body, meta: { jobKind: "implement", runMode: "autonomous" } });

        it("BLOCKS to Needs Input when declared body paths hit a block rule, before any worktree", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git, calls } = fakeGit();
            const { fs, store } = memRunsFs();
            const events: NotifyEvent[] = [];
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    notify: {
                        notify: async (evt: NotifyEvent): Promise<void> => {
                            events.push(evt);
                        },
                    },
                    registry: policyRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "block", paths: ["infra/**"] }],
                    }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBe("preflight");
            // The agent never ran and no worktree was created.
            expect(seen).toHaveLength(0);
            expect(calls.some((c) => c.includes("add"))).toBe(false);
            // Moved to Needs Input with the block comment; never moved to In Progress.
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes(PREFLIGHT_BLOCK_MESSAGE))).toBe(
                true,
            );
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Progress")).toBe(false);
            // No record was claimed; escalation fired as needs_input.
            expect(store.size).toBe(0);
            expect(events.some((e) => e.reason === "needs_input")).toBe(true);
        });

        it("PROCEEDS when declared paths hit only require_approval (post-diff gate stays authoritative)", async () => {
            const tracker = new FakeTracker(declaringIssue("Refactor src/core/run.ts to share the resolver."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git, calls } = fakeGit();
            const { fs } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    registry: policyRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "require_approval", paths: ["src/**"] }],
                    }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
            expect(calls.some((c) => c.includes("add"))).toBe(true);
        });

        it("PROCEEDS when declared paths hit only allow", async () => {
            const tracker = new FakeTracker(declaringIssue("Tweak src/core/run.ts behavior."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    registry: policyRegistry({ evaluator: "globs", rules: [{ decision: "allow", paths: ["src/**"] }] }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
        });

        it("PROCEEDS (conservative) when the issue declares no paths, even under a block rule", async () => {
            const tracker = new FakeTracker(declaringIssue("The deploy keeps failing; please make it work again."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    registry: policyRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "block", paths: ["infra/**"] }],
                    }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
        });

        it("is SKIPPED when the policy evaluator is off", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    registry: policyRegistry({ evaluator: "off" }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
        });

        it("is SKIPPED for a non-implement job kind even when declared paths hit a block rule", async () => {
            const tracker = new FakeTracker(
                makeIssue({
                    body: "Rotate the secrets in infra/secrets.tf for the deploy.",
                    meta: { jobKind: "triage", runMode: "autonomous" },
                }),
            );
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    registry: policyRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "block", paths: ["infra/**"] }],
                    }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
        });

        it("blocks via the agentowners evaluator using the injected reader against the base repo", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git, calls } = fakeGit();
            const { fs } = memRunsFs();
            const readPaths: string[] = [];
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: autonomousConfig,
                    driver,
                    git,
                    policyReader: async (path: string): Promise<string | undefined> => {
                        readPaths.push(path);
                        return "infra/** block\n";
                    },
                    registry: policyRegistry({ evaluator: "agentowners" }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBe("preflight");
            expect(seen).toHaveLength(0);
            expect(calls.some((c) => c.includes("add"))).toBe(false);
            // The AGENTOWNERS file is read from the BASE repo (exists pre-worktree).
            expect(readPaths.some((p) => p.startsWith("/repo/bin"))).toBe(true);
        });

        // The predictive preflight reads the durable decision log through the SAME fake
        // Fs the run uses; this config points it at a known dir so seeded events are read.
        const predictiveConfig: Config = { ...autonomousConfig, decisions: { dir: "/decisions" } };

        function seedDecision(fs: RunStoreFs, key: string, decision: PolicyDecision, changedFiles: string[]): void {
            const event = buildDecisionEvent(
                { changedFiles, decision, evaluator: "globs", key, matchedRules: [], reason: "r", runId: `${key}@t` },
                fixedClock,
                () => `d-${key}`,
            );
            fs.append(join(resolveDecisionsDir("/decisions"), "decisions.ndjson"), `${JSON.stringify(event)}\n`);
        }

        it("WARNS (advisory) and PROCEEDS when declared scope overlaps a prior block in the same project", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git, calls } = fakeGit();
            const { fs } = memRunsFs();
            seedDecision(fs, "CG-7", "block", ["infra/secrets.tf"]);
            const logs: string[] = [];
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: predictiveConfig,
                    driver,
                    git,
                    log: (m) => {
                        logs.push(m);
                    },
                    // No active rule on this path, so the live gate ALLOWS — only history warns.
                    registry: policyRegistry({ evaluator: "globs", rules: [] }),
                    runsFs: fs,
                    tracker,
                }),
            );

            // Advisory only: the run proceeds (worktree created, agent ran) — never parked.
            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
            expect(calls.some((c) => c.includes("add"))).toBe(true);
            const warning = logs.find((m) => m.includes("heads up"));
            expect(warning).toBeDefined();
            expect(warning).toContain("CG-7: infra/secrets.tf");
            expect(warning).toContain("the live policy gate remains authoritative");
        });

        it("does not warn when there is no overlapping prior decision", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            seedDecision(fs, "CG-7", "block", ["src/unrelated.ts"]);
            const logs: string[] = [];
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: predictiveConfig,
                    driver,
                    git,
                    log: (m) => {
                        logs.push(m);
                    },
                    registry: policyRegistry({ evaluator: "globs", rules: [] }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
            expect(logs.some((m) => m.includes("heads up"))).toBe(false);
        });

        it("does not warn for a prior decision in a DIFFERENT project over the same path", async () => {
            const tracker = new FakeTracker(declaringIssue("Rotate the secrets in infra/secrets.tf for the deploy."));
            const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
            const { git } = fakeGit();
            const { fs } = memRunsFs();
            // Same overlapping path, but a different project key — must be scoped out.
            seedDecision(fs, "OTHER-7", "block", ["infra/secrets.tf"]);
            const logs: string[] = [];
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    config: predictiveConfig,
                    driver,
                    git,
                    log: (m) => {
                        logs.push(m);
                    },
                    registry: policyRegistry({ evaluator: "globs", rules: [] }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(result.parked).toBeUndefined();
            expect(seen).toHaveLength(1);
            expect(logs.some((m) => m.includes("heads up"))).toBe(false);
        });
    });

    // A tracker that records issueContext calls and returns a configurable context,
    // So the dispatched task can be checked for the linked-context block.
    class ContextTracker extends FakeTracker {
        contextCalls = 0;
        constructor(
            issue: Issue,
            private readonly context: IssueContext | Error,
        ) {
            super(issue);
        }
        override async issueContext(): Promise<IssueContext> {
            this.contextCalls += 1;
            if (this.context instanceof Error) {
                throw this.context;
            }
            return this.context;
        }
    }

    it("inlines the parent + attachments block into the dispatched task (default on)", async () => {
        const tracker = new ContextTracker(makeIssue(), {
            attachments: [{ name: "trace.log", url: "https://x/trace" }],
            parent: { body: "epic goal", key: "CG-1", title: "Epic", type: "Epic" },
        });
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        await runIssue("CG-42", {}, deps({ driver, tracker }));

        expect(tracker.contextCalls).toBe(1);
        expect(seen[0]!.task).toContain("## Linked context");
        expect(seen[0]!.task).toContain('Parent Epic CG-1 "Epic":');
        expect(seen[0]!.task).toContain("- trace.log (https://x/trace)");
    });

    it("omits the block and never calls issueContext when defaults.linkedContext is false", async () => {
        const tracker = new ContextTracker(makeIssue(), {
            attachments: [{ name: "trace.log", url: "https://x/trace" }],
            parent: { body: "epic goal", key: "CG-1", title: "Epic", type: "Epic" },
        });
        const { driver, seen } = fakeDriver({ status: "done", summary: "s" });
        const cfg: Config = { ...config, linkedContext: false };
        await runIssue("CG-42", {}, deps({ config: cfg, driver, tracker }));

        expect(tracker.contextCalls).toBe(0);
        expect(seen[0]!.task).not.toContain("## Linked context");
    });

    it("still dispatches the run when issueContext throws (degrade-safe)", async () => {
        const tracker = new ContextTracker(makeIssue(), new Error("attachments boom"));
        const { driver, seen, order } = fakeDriver({ status: "done", summary: "s" });
        await runIssue("CG-42", {}, deps({ driver, tracker }));

        expect(tracker.contextCalls).toBe(1);
        expect(order).toContain("run");
        expect(seen[0]!.task).not.toContain("## Linked context");
    });

    describe("quality gate", () => {
        // A registry whose CG project opts into the gate with the given commands.
        function gateRegistry(commands: string[]): Registry {
            return {
                ...registry,
                projects: {
                    ...registry.projects,
                    CG: { ...registry.projects.CG!, qualityGate: { commands } },
                },
            };
        }

        const implementIssue = (): Issue => makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } });

        // A driver returning a scripted report per call (call 1 = initial, call 2 = rework).
        function scriptedDriver(reports: (Report | null)[]): { driver: AgentDriver; seen: RunOptions[] } {
            const seen: RunOptions[] = [];
            let call = 0;
            const driver: AgentDriver = {
                cancel: async () => {},
                ensureSession: async () => {},
                run: async (opts: RunOptions): Promise<AgentRunResult> => {
                    seen.push(opts);
                    const report = reports[call] ?? null;
                    call += 1;
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

        // A fake GateExec returning a scripted exit code per command-string, repeating
        // The last entry for any further invocations (so successive gate runs can differ).
        function scriptedGate(perCall: { exitCode: number; output: string }[]): {
            exec: GateExec;
            calls: { command: string; cwd: string }[];
        } {
            const calls: { command: string; cwd: string }[] = [];
            let idx = 0;
            const exec: GateExec = async (command, cwd) => {
                calls.push({ command, cwd });
                const out = perCall[Math.min(idx, perCall.length - 1)]!;
                idx += 1;
                return out;
            };
            return { calls, exec };
        }

        it("green gate → In Review (one dispatch, report applied)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([{ prUrl: "http://pr/1", status: "done", summary: "shipped" }]);
            const { exec, calls } = scriptedGate([{ exitCode: 0, output: "ok" }]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: gateRegistry(["bun test"]), tracker }),
            );

            expect(seen).toHaveLength(1);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.cwd).toBe("/repo/bin");
            expect(result.applied).toEqual({ movedTo: "In Review" });
        });

        it("red gate → auto-rework → green → In Review (driver runs twice)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "fixed" },
            ]);
            const { exec } = scriptedGate([
                { exitCode: 1, output: "FAIL: 1 test failing" },
                { exitCode: 0, output: "ok" },
            ]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: gateRegistry(["bun test"]), tracker }),
            );

            expect(seen).toHaveLength(2);
            // The rework re-prompt carries the failing gate output.
            expect(seen[1]!.task).toContain("FAIL: 1 test failing");
            expect(result.applied).toEqual({ movedTo: "In Review" });
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(true);
        });

        it("red gate → auto-rework → still red → failed (Needs Input + failed label + attempts incremented)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { fs, store } = memRunsFs();
            const { driver } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "still broken" },
            ]);
            const { exec } = scriptedGate([{ exitCode: 1, output: "FAIL: still red" }]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: gateRegistry(["bun test"]), runsFs: fs, tracker }),
            );

            // applyReport(failed): comment + Needs Input + failed label.
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
            expect(
                tracker.calls.some(
                    (c) => c.kind === "comment" && c.body.includes("Quality gate failed after auto-rework"),
                ),
            ).toBe(true);
            // No advance to In Review.
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);

            const rec = onlyRecord(store);
            expect(rec?.status).toBe("failed");
            // attempts incremented from the run-record baseline (0 on a fresh dispatch) to 1.
            expect(rec?.attempts).toBe(1);
            expect(result.result.report?.summary).toBe("still broken");
        });

        it("manual move DURING gate-rework yields (no writeback, cleanup like the main yield path)", async () => {
            // Started for resolve + the first yield check (so we reach the gate), then a
            // Cancelled read on the post-rework yield check → the human took the card.
            class ReworkFlipTracker extends FakeTracker {
                private reads = 0;
                constructor() {
                    super(makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } }));
                }
                override async getIssue(): Promise<Issue> {
                    this.reads += 1;
                    const base = makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } });
                    if (this.reads <= 2) {
                        return { ...base, state: { group: "started", name: "In Progress" } };
                    }
                    return { ...base, state: { group: "cancelled", name: "Cancelled" } };
                }
            }
            const tracker = new ReworkFlipTracker();
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "reworked" },
            ]);
            const { exec, calls } = scriptedGate([{ exitCode: 1, output: "FAIL: red" }]);
            const { git, calls: gitCalls } = fakeGit();
            const { fs, store } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, git, registry: gateRegistry(["bun test"]), runsFs: fs, tracker }),
            );

            // Both dispatches ran (initial + the one rework).
            expect(seen).toHaveLength(2);
            // The gate ran once (initial red → rework); the post-rework yield short-circuits
            // Before the rework gate re-check.
            expect(calls).toHaveLength(1);
            // Yielded: no writeback to In Review or Needs Input.
            expect(result.applied).toBeUndefined();
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(false);
            // Worktree removed and record deleted, exactly like the main yield path.
            expect(gitCalls.some((c) => c.includes("remove"))).toBe(true);
            expect(store.size).toBe(0);
        });

        it("accumulates attempts across gate-failure dispatches (crash-resume baseline + 1)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { fs, store } = memRunsFs();
            // Prior crash-resume record at attempts 2; a continuation-less resume increments to 3.
            saveRecord(
                "/runs",
                {
                    agent: "claude",
                    attempts: 2,
                    cwd: "/wt/cg-42",
                    jobKind: "implement",
                    key: "CG-42",
                    runMode: "autonomous",
                    sessionName: "CG-42",
                    status: "in_progress",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                },
                fs,
            );
            const { driver } = scriptedDriver([
                { status: "done", summary: "first" },
                { status: "done", summary: "still broken" },
            ]);
            const { exec } = scriptedGate([{ exitCode: 1, output: "FAIL" }]);
            const { git } = fakeGit();
            await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    gateExec: exec,
                    git,
                    pathExists: (p) => p === "/wt/cg-42",
                    registry: gateRegistry(["bun test"]),
                    runsFs: fs,
                    tracker,
                }),
            );
            const rec = onlyRecord(store);
            // Crash-resume bumped the in-run baseline to 3; the gate failure adds one → 4.
            expect(rec?.attempts).toBe(4);
        });

        it("multiple commands: the second command fails → red → rework", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([
                { status: "done", summary: "first" },
                { status: "done", summary: "fixed" },
            ]);
            // First command passes, second fails (stops there), then the rework re-check is green.
            const calls: { command: string; cwd: string }[] = [];
            let phase = 0;
            const exec: GateExec = async (command, cwd) => {
                calls.push({ command, cwd });
                if (phase === 0) {
                    if (command === "bun run lint") {
                        return { exitCode: 0, output: "lint ok" };
                    }
                    phase = 1;
                    return { exitCode: 2, output: "type error" };
                }
                return { exitCode: 0, output: "ok" };
            };
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    gateExec: exec,
                    registry: gateRegistry(["bun run lint", "bun run typecheck"]),
                    tracker,
                }),
            );

            // First gate phase ran both commands (lint passed, typecheck failed).
            expect(calls.slice(0, 2).map((c) => c.command)).toEqual(["bun run lint", "bun run typecheck"]);
            expect(seen).toHaveLength(2);
            expect(seen[1]!.task).toContain("type error");
            expect(result.applied).toEqual({ movedTo: "In Review" });
        });

        it("gate off (no commands) → unchanged behavior (one dispatch, In Review)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([{ prUrl: "http://pr/1", status: "done", summary: "shipped" }]);
            let gateCalled = false;
            const exec: GateExec = async () => {
                gateCalled = true;
                return { exitCode: 0, output: "" };
            };
            const result = await runIssue("CG-42", {}, deps({ driver, gateExec: exec, tracker }));

            expect(seen).toHaveLength(1);
            expect(gateCalled).toBe(false);
            expect(result.applied).toEqual({ movedTo: "In Review" });
        });

        it("gate exec THROWS → logged, proceeds as done (fail-open runner)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([{ prUrl: "http://pr/1", status: "done", summary: "shipped" }]);
            const exec: GateExec = async () => {
                throw new Error("gate runner exploded");
            };
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: gateRegistry(["bun test"]), tracker }),
            );

            // No rework dispatch; the done report is applied unchanged.
            expect(seen).toHaveLength(1);
            expect(result.applied).toEqual({ movedTo: "In Review" });
        });

        // A registry whose CG project opts into the gate AND a rework budget.
        function reworkRegistry(commands: string[], maxRework: number): Registry {
            return {
                ...registry,
                projects: {
                    ...registry.projects,
                    CG: { ...registry.projects.CG!, qualityGate: { commands, maxRework } },
                },
            };
        }

        it("maxRework 0: a red gate parks failed WITHOUT dispatching any rework", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { fs, store } = memRunsFs();
            const { driver, seen } = scriptedDriver([{ prUrl: "http://pr/1", status: "done", summary: "first" }]);
            const { exec, calls } = scriptedGate([{ exitCode: 1, output: "FAIL: red" }]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: reworkRegistry(["bun test"], 0), runsFs: fs, tracker }),
            );

            // Only the initial dispatch ran; no rework was attempted.
            expect(seen).toHaveLength(1);
            // The gate ran once and never re-ran.
            expect(calls).toHaveLength(1);
            // Parked failed, no advance to In Review.
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
            expect(onlyRecord(store)?.status).toBe("failed");
            expect(result.result.report?.summary).toBe("first");
        });

        it("maxRework 1: red → one rework → green is adopted (driver runs twice, In Review)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "fixed" },
            ]);
            const { exec } = scriptedGate([
                { exitCode: 1, output: "FAIL: 1 test failing" },
                { exitCode: 0, output: "ok" },
            ]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: reworkRegistry(["bun test"], 1), tracker }),
            );

            expect(seen).toHaveLength(2);
            expect(seen[1]!.task).toContain("FAIL: 1 test failing");
            expect(result.applied).toEqual({ movedTo: "In Review" });
        });

        it("maxRework 1: red → one rework → still red parks failed (no second rework)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { fs, store } = memRunsFs();
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "still broken" },
            ]);
            const { exec } = scriptedGate([{ exitCode: 1, output: "FAIL: still red" }]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: reworkRegistry(["bun test"], 1), runsFs: fs, tracker }),
            );

            // One rework only; budget of 1 is not exceeded.
            expect(seen).toHaveLength(2);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
            expect(onlyRecord(store)?.status).toBe("failed");
            expect(result.result.report?.summary).toBe("still broken");
        });

        it("maxRework 2: red, red, then a third dispatch is NOT attempted (parks failed after 2 reworks)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { fs, store } = memRunsFs();
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "second" },
                { prUrl: "http://pr/1", status: "done", summary: "third" },
            ]);
            const { exec } = scriptedGate([{ exitCode: 1, output: "FAIL: persistently red" }]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: reworkRegistry(["bun test"], 2), runsFs: fs, tracker }),
            );

            // Initial + exactly 2 reworks = 3 dispatches; no fourth.
            expect(seen).toHaveLength(3);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
            expect(onlyRecord(store)?.status).toBe("failed");
            // Each rework re-prompt carried the latest failing gate output.
            expect(seen[1]!.task).toContain("FAIL: persistently red");
            expect(seen[2]!.task).toContain("FAIL: persistently red");
            expect(result.result.report?.summary).toBe("third");
        });

        it("maxRework 2: red, then the SECOND rework goes green and is adopted (In Review)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver, seen } = scriptedDriver([
                { prUrl: "http://pr/1", status: "done", summary: "first" },
                { prUrl: "http://pr/1", status: "done", summary: "second" },
                { prUrl: "http://pr/1", status: "done", summary: "third-fixed" },
            ]);
            // Initial red, first rework still red, second rework green.
            const { exec } = scriptedGate([
                { exitCode: 1, output: "FAIL: red 1" },
                { exitCode: 1, output: "FAIL: red 2" },
                { exitCode: 0, output: "ok" },
            ]);
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: exec, registry: reworkRegistry(["bun test"], 2), tracker }),
            );

            // Two reworks (3 dispatches), then green adopted → In Review.
            expect(seen).toHaveLength(3);
            // The second rework re-prompt carried the first rework's failing output.
            expect(seen[2]!.task).toContain("FAIL: red 2");
            expect(result.applied).toEqual({ movedTo: "In Review" });
            expect(result.result.report?.summary).toBe("third-fixed");
        });
    });

    describe("beflow-owned PR", () => {
        const implementIssue = (): Issue => makeIssue({ meta: { jobKind: "implement", runMode: "autonomous" } });

        // A registry whose CG project owns the PR via beflow, against a concrete base
        // branch (so detectBaseBranch never calls gh), with an optional policy block.
        function beflowRegistry(policy?: Registry["projects"]["CG"]["policy"]): Registry {
            return {
                ...registry,
                projects: {
                    ...registry.projects,
                    CG: {
                        ...registry.projects.CG!,
                        pr: { baseBranch: "main", owner: "beflow" },
                        ...(policy !== undefined ? { policy } : {}),
                    },
                },
            };
        }

        // A configurable fake `Exec` for the PR layer: scripts the git/gh calls that
        // pr.ts and policy.ts issue and records every invocation for assertions.
        function fakePrExec(opts: { commits?: number; changedFiles?: string[] } = {}): {
            exec: Exec;
            calls: string[][];
        } {
            const calls: string[][] = [];
            const commits = opts.commits ?? 1;
            const changed = opts.changedFiles ?? ["src/app.ts"];
            const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                calls.push([cmd, ...args]);
                if (cmd === "git" && args.includes("rev-list")) {
                    return { code: 0, stderr: "", stdout: `${String(commits)}\n` };
                }
                if (cmd === "git" && args.includes("diff")) {
                    return { code: 0, stderr: "", stdout: `${changed.join("\n")}\n` };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    return { code: 0, stderr: "", stdout: "https://gh/pr/99\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            };
            return { calls, exec };
        }

        it("no-op (agent produced no commits): marks failed, opens no PR, keeps the worktree", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ status: "done", summary: "claims done" });
            const { git, calls: gitCalls } = fakeGit();
            const { exec, calls: prCalls } = fakePrExec({ commits: 0 });
            const { fs, store } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, git, prExec: exec, registry: beflowRegistry(), runsFs: fs, tracker }),
            );

            // Failed writeback (failed label + Needs Input), no PR created, worktree kept.
            expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(prCalls.some((c) => c[0] === "gh" && c[2] === "create")).toBe(false);
            expect(gitCalls.some((c) => c.includes("remove"))).toBe(false);
            expect(onlyRecord(store)?.status).toBe("failed");
            expect(result.applied?.movedTo).toBe("Needs Input");
        });

        it("commits + allow policy: opens a draft PR, marks it ready, → In Review with the PR linked", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ status: "done", summary: "shipped" });
            const { git } = fakeGit();
            const { exec, calls: prCalls } = fakePrExec();
            const { fs, store } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    prExec: exec,
                    registry: beflowRegistry({ evaluator: "off" }),
                    runsFs: fs,
                    tracker,
                }),
            );

            expect(prCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "create")).toBe(true);
            expect(prCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "ready")).toBe(true);
            expect(result.applied).toEqual({ movedTo: "In Review" });
            // The beflow-created PR URL is linked and persisted on the record.
            expect(tracker.calls.some((c) => c.kind === "linkPR" && c.url === "https://gh/pr/99")).toBe(true);
            expect(onlyRecord(store)?.prUrl).toBe("https://gh/pr/99");
        });

        it("require_approval policy: leaves the PR draft, → In Review, posts an awaits-approval note", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ status: "done", summary: "shipped" });
            const { git } = fakeGit();
            const { exec, calls: prCalls } = fakePrExec();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    prExec: exec,
                    registry: beflowRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "require_approval", paths: ["src/**"] }],
                    }),
                    tracker,
                }),
            );

            // Enriched (edit) but NOT marked ready — the draft is the review artifact.
            expect(prCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "edit")).toBe(true);
            expect(prCalls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "ready")).toBe(false);
            expect(result.applied).toEqual({ movedTo: "In Review" });
            expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("requires human approval"))).toBe(
                true,
            );
        });

        it("block policy: closes the PR but KEEPS the branch, comments the reason, routes to Needs Input (NOT In Review)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ status: "done", summary: "shipped" });
            const { git } = fakeGit();
            const { exec, calls: prCalls } = fakePrExec({ changedFiles: ["infra/secrets.tf"] });
            const { fs, store } = memRunsFs();
            const result = await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    prExec: exec,
                    registry: beflowRegistry({
                        evaluator: "globs",
                        rules: [{ decision: "block", paths: ["infra/**"] }],
                    }),
                    runsFs: fs,
                    tracker,
                }),
            );

            // The PR is closed WITHOUT --delete-branch, and the branch is never deleted locally.
            const closeCall = prCalls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "close");
            expect(closeCall).toBeDefined();
            expect(closeCall).not.toContain("--delete-branch");
            expect(prCalls.some((c) => c[0] === "git" && c.includes("-D"))).toBe(false);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
            expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "Needs Input")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "blocked")).toBe(true);
            expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("Policy blocked"))).toBe(true);
            expect(onlyRecord(store)?.status).toBe("blocked");
            expect(result.applied?.movedTo).toBe("Needs Input");
        });

        it("gh failure while opening the PR: marks failed, keeps the worktree (retryable)", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ status: "done", summary: "shipped" });
            const { git, calls: gitCalls } = fakeGit();
            const { fs, store } = memRunsFs();
            // gh pr create fails AND gh pr view (the idempotent fallback) fails too.
            const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                if (cmd === "git" && args.includes("rev-list")) {
                    return { code: 0, stderr: "", stdout: "1\n" };
                }
                if (cmd === "gh") {
                    return { code: 1, stderr: "gh: network error", stdout: "" };
                }
                return { code: 0, stderr: "", stdout: "" };
            };
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, git, prExec: exec, registry: beflowRegistry(), runsFs: fs, tracker }),
            );

            expect(tracker.calls.some((c) => c.kind === "addProperty" && c.label === "failed")).toBe(true);
            expect(gitCalls.some((c) => c.includes("remove"))).toBe(false);
            expect(onlyRecord(store)?.status).toBe("failed");
            // The PR-layer-failure park persists attempts 0: the agent succeeded,
            // so the next dispatch must not inherit a stale attempt count.
            expect(onlyRecord(store)?.attempts).toBe(0);
            expect(result.applied?.movedTo).toBe("Needs Input");
        });

        it("survives a quality-gate rework: the beflow PR stays linked after the agent re-emits done", async () => {
            const tracker = new FakeTracker(implementIssue());
            // Initial done → red gate → rework done (no prUrl from the agent) → green gate.
            const reports: (Report | null)[] = [
                { status: "done", summary: "first" },
                { status: "done", summary: "fixed" },
            ];
            let call = 0;
            const driver: AgentDriver = {
                cancel: async () => {},
                ensureSession: async () => {},
                run: async (): Promise<AgentRunResult> => {
                    const report = reports[call] ?? null;
                    call += 1;
                    return {
                        exitCode: 0,
                        raw: [],
                        report,
                        stream: { assistantText: "", toolCalls: [] },
                        timedOut: false,
                    };
                },
            };
            let gateIdx = 0;
            const gate: GateExec = async () => {
                const out = gateIdx === 0 ? { exitCode: 1, output: "FAIL" } : { exitCode: 0, output: "ok" };
                gateIdx += 1;
                return out;
            };
            const { git } = fakeGit();
            const { exec } = fakePrExec();
            const { fs, store } = memRunsFs();
            const reg = beflowRegistry({ evaluator: "off" });
            const gated: Registry = {
                ...reg,
                projects: { ...reg.projects, CG: { ...reg.projects.CG!, qualityGate: { commands: ["bun test"] } } },
            };
            const result = await runIssue(
                "CG-42",
                {},
                deps({ driver, gateExec: gate, git, prExec: exec, registry: gated, runsFs: fs, tracker }),
            );

            expect(call).toBe(2);
            expect(result.applied).toEqual({ movedTo: "In Review" });
            expect(tracker.calls.some((c) => c.kind === "linkPR" && c.url === "https://gh/pr/99")).toBe(true);
            expect(onlyRecord(store)?.prUrl).toBe("https://gh/pr/99");
        });

        it("agent-owned (default): beflow opens no PR; the agent's report.prUrl is linked unchanged", async () => {
            const tracker = new FakeTracker(implementIssue());
            const { driver } = fakeDriver({ prUrl: "http://agent/pr/1", status: "done", summary: "shipped" });
            const { git } = fakeGit();
            let prExecCalled = false;
            const exec: Exec = async (): Promise<ExecResult> => {
                prExecCalled = true;
                return { code: 0, stderr: "", stdout: "" };
            };
            const { fs, store } = memRunsFs();
            const result = await runIssue("CG-42", {}, deps({ driver, git, prExec: exec, runsFs: fs, tracker }));

            // owner defaults to agent → beflow never touches the PR layer.
            expect(prExecCalled).toBe(false);
            expect(result.applied).toEqual({ movedTo: "In Review" });
            expect(tracker.calls.some((c) => c.kind === "linkPR" && c.url === "http://agent/pr/1")).toBe(true);
            expect(onlyRecord(store)?.prUrl).toBe("http://agent/pr/1");
        });

        it("hands the agent's change receipt to the post-run policy command on stdin", async () => {
            const tracker = new FakeTracker(implementIssue());
            const receipt: ChangeReceipt = {
                intent: "add a login route",
                riskSurfaces: ["app", "auth"],
                surfaceNotes: { auth: "no change to token signing" },
            };
            const { driver } = fakeDriver({ receipt, status: "done", summary: "shipped" });
            const { git } = fakeGit();
            const { exec } = fakePrExec();
            let seenStdin = "";
            const policyExec: PolicyExec = async (_argv, _cwd, stdin) => {
                seenStdin = stdin;
                return { exitCode: 0, stderr: "", stdout: '{"decision":"allow"}' };
            };
            await runIssue(
                "CG-42",
                {},
                deps({
                    driver,
                    git,
                    policyExec,
                    prExec: exec,
                    registry: beflowRegistry({ command: ["policy.sh"], evaluator: "command", onBlock: "comment" }),
                    tracker,
                }),
            );

            const parsed: unknown = JSON.parse(seenStdin);
            expect(parsed).toMatchObject({ receipt });
        });

        describe("decision log", () => {
            it("writes an allow decision event with structured matchedRules", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                const { exec } = fakePrExec({ changedFiles: ["src/app.ts"] });
                const { sink, events } = capturingSink();
                await runIssue(
                    "CG-42",
                    {},
                    deps({
                        decisionSink: sink,
                        driver,
                        git,
                        prExec: exec,
                        registry: beflowRegistry({
                            evaluator: "globs",
                            rules: [{ decision: "allow", paths: ["src/**"] }],
                        }),
                        tracker,
                    }),
                );

                expect(events).toHaveLength(1);
                const event = events[0]!;
                expect(event.decision).toBe("allow");
                expect(event.evaluator).toBe("globs");
                expect(event.key).toBe("CG-42");
                expect(event.prUrl).toBe("https://gh/pr/99");
                expect(event.changedFiles).toEqual(["src/app.ts"]);
                expect(event.matchedRules).toEqual([{ decision: "allow", paths: ["src/**"] }]);
                expect(event.changedFilesHash).toMatch(/^[0-9a-f]{64}$/);
                expect(event.decisionInputHash).toMatch(/^[0-9a-f]{64}$/);
            });

            it("writes a require_approval decision event", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                const { exec } = fakePrExec();
                const { sink, events } = capturingSink();
                await runIssue(
                    "CG-42",
                    {},
                    deps({
                        decisionSink: sink,
                        driver,
                        git,
                        prExec: exec,
                        registry: beflowRegistry({
                            evaluator: "globs",
                            rules: [{ decision: "require_approval", paths: ["src/**"] }],
                        }),
                        tracker,
                    }),
                );

                expect(events).toHaveLength(1);
                expect(events[0]!.decision).toBe("require_approval");
                expect(events[0]!.matchedRules).toEqual([{ decision: "require_approval", paths: ["src/**"] }]);
            });

            it("writes a block decision event", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                const { exec } = fakePrExec({ changedFiles: ["infra/secrets.tf"] });
                const { sink, events } = capturingSink();
                await runIssue(
                    "CG-42",
                    {},
                    deps({
                        decisionSink: sink,
                        driver,
                        git,
                        prExec: exec,
                        registry: beflowRegistry({
                            evaluator: "globs",
                            rules: [{ decision: "block", paths: ["infra/**"] }],
                        }),
                        tracker,
                    }),
                );

                expect(events).toHaveLength(1);
                expect(events[0]!.decision).toBe("block");
                expect(events[0]!.matchedRules).toEqual([{ decision: "block", paths: ["infra/**"] }]);
            });

            it("the allow decision event SURVIVES the run-record GC (written before deleteRecord)", async () => {
                // The default LocalNdjsonSink writes to a SIBLING dir of the runs dir; the
                // Run record is the only .json. After a clean allow the record may be GC'd,
                // But the decision log line persists — the core hole this issue closes.
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                const { exec } = fakePrExec({ changedFiles: ["src/app.ts"] });
                const { fs, store } = memRunsFs();
                await runIssue(
                    "CG-42",
                    {},
                    deps({
                        config: { ...config, decisions: { dir: "/decisions" } },
                        driver,
                        git,
                        prExec: exec,
                        registry: beflowRegistry({ evaluator: "off" }),
                        runsFs: fs,
                        tracker,
                    }),
                );

                // The decision NDJSON line is present regardless of the run record's fate.
                const ndjson = store.get(join("/decisions", "decisions.ndjson")) ?? "";
                const written = ndjson
                    .split("\n")
                    .filter((line) => line.length > 0)
                    .map((line): unknown => JSON.parse(line));
                expect(written).toHaveLength(1);
                expect(written[0]).toMatchObject({ decision: "allow", key: "CG-42" });
            });

            it("appends across runs (append-only, not overwrite)", async () => {
                const { fs, store } = memRunsFs();
                const cfg: Config = { ...config, decisions: { dir: "/decisions" } };
                const reg = beflowRegistry({ evaluator: "off" });
                for (const summary of ["first", "second"]) {
                    const tracker = new FakeTracker(implementIssue());
                    const { driver } = fakeDriver({ status: "done", summary });
                    const { git } = fakeGit();
                    const { exec } = fakePrExec({ changedFiles: ["src/app.ts"] });
                    await runIssue(
                        "CG-42",
                        {},
                        deps({ config: cfg, driver, git, prExec: exec, registry: reg, runsFs: fs, tracker }),
                    );
                }

                const ndjson = store.get(join("/decisions", "decisions.ndjson")) ?? "";
                const written = ndjson.split("\n").filter((line) => line.length > 0);
                expect(written).toHaveLength(2);
            });
        });

        describe("quality-gate baseline pinning", () => {
            // Beflow-owned + a gate + baselineTestGlobs: the gate must run against the
            // Target branch's test files, not the worktree's (possibly weakened) ones.
            function pinnedRegistry(): Registry {
                const reg = beflowRegistry({ evaluator: "off" });
                return {
                    ...reg,
                    projects: {
                        ...reg.projects,
                        CG: {
                            ...reg.projects.CG!,
                            qualityGate: { baselineTestGlobs: ["**/*.test.ts"], commands: ["bun test"] },
                        },
                    },
                };
            }

            it("a weakened test cannot self-grade green: the gate runs against the pinned baseline", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                // The run changed a test file. The baseline (pinned) tests FAIL — the
                // Agent's own weakened tree would have passed, but the gate never sees it.
                const checkouts: string[][] = [];
                const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                    if (cmd === "git" && args.includes("rev-list")) {
                        return { code: 0, stderr: "", stdout: "1\n" };
                    }
                    if (cmd === "git" && args.includes("diff")) {
                        return { code: 0, stderr: "", stdout: "src/app.ts\nsrc/app.test.ts\n" };
                    }
                    if (cmd === "git" && args.includes("cat-file")) {
                        // Modified test: present in both base and HEAD.
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "git" && args.includes("checkout")) {
                        checkouts.push(args);
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                        return { code: 0, stderr: "", stdout: "https://gh/pr/99\n" };
                    }
                    return { code: 0, stderr: "", stdout: "" };
                };
                // The pinned-baseline gate stays RED through the single rework → failed.
                const gate: GateExec = async () => ({ exitCode: 1, output: "FAIL: baseline test broke" });
                const { fs, store } = memRunsFs();
                const result = await runIssue(
                    "CG-42",
                    {},
                    deps({
                        driver,
                        gateExec: gate,
                        git,
                        prExec: exec,
                        registry: pinnedRegistry(),
                        runsFs: fs,
                        tracker,
                    }),
                );

                // Only the changed test file is pinned (checked out from base), not src/app.ts.
                const pinned = checkouts.find((c) => c.includes("main"));
                expect(pinned).toBeDefined();
                expect(pinned).toContain("src/app.test.ts");
                expect(pinned).not.toContain("src/app.ts");
                // The worktree's own files are restored afterward (checkout HEAD).
                expect(checkouts.some((c) => c.includes("HEAD") && c.includes("src/app.test.ts"))).toBe(true);
                // Self-grading is impossible: the baseline gate is red → parked failed.
                expect(result.applied?.movedTo).toBe("Needs Input");
                expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
                expect(onlyRecord(store)?.status).toBe("failed");
            });

            it("a DELETED test cannot self-grade green: baseline is restored and the gate goes red", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                // The agent DELETED src/app.test.ts (present in base, absent in HEAD) so
                // its own tree would pass with no test. The gate must pin the base copy.
                const checkouts: string[][] = [];
                const removes: string[][] = [];
                const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                    if (cmd === "git" && args.includes("rev-list")) {
                        return { code: 0, stderr: "", stdout: "1\n" };
                    }
                    if (cmd === "git" && args.includes("diff")) {
                        return { code: 0, stderr: "", stdout: "src/app.test.ts\n" };
                    }
                    if (cmd === "git" && args.includes("cat-file")) {
                        const spec = args[args.length - 1] ?? "";
                        // Present in base, absent in HEAD (the agent deleted it).
                        return spec.startsWith("HEAD:")
                            ? { code: 1, stderr: "not found", stdout: "" }
                            : { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "git" && args.includes("checkout")) {
                        checkouts.push(args);
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "git" && args.includes("rm")) {
                        removes.push(args);
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                        return { code: 0, stderr: "", stdout: "https://gh/pr/99\n" };
                    }
                    return { code: 0, stderr: "", stdout: "" };
                };
                // The pinned baseline test FAILS (the implementation no longer satisfies it).
                const gate: GateExec = async () => ({ exitCode: 1, output: "FAIL: deleted test restored" });
                const { fs, store } = memRunsFs();
                const result = await runIssue(
                    "CG-42",
                    {},
                    deps({
                        driver,
                        gateExec: gate,
                        git,
                        prExec: exec,
                        registry: pinnedRegistry(),
                        runsFs: fs,
                        tracker,
                    }),
                );

                // The base copy is laid down so the gate cannot grade against "no test".
                expect(checkouts.some((c) => c.includes("main") && c.includes("src/app.test.ts"))).toBe(true);
                // Restore matches HEAD by REMOVING the file again — never `checkout HEAD`
                // (which would throw on an absent path and fail the gate open).
                expect(checkouts.some((c) => c.includes("HEAD"))).toBe(false);
                expect(removes.some((c) => c.includes("src/app.test.ts"))).toBe(true);
                // Self-grading is impossible: the baseline gate is red → parked failed.
                expect(result.applied?.movedTo).toBe("Needs Input");
                expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
                expect(onlyRecord(store)?.status).toBe("failed");
            });

            it("an ADDED test does NOT fail the gate open: it is excluded from pinning", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                // The run ADDED src/added.test.ts (absent in base) and modified src/app.test.ts.
                const checkouts: string[][] = [];
                const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                    if (cmd === "git" && args.includes("rev-list")) {
                        return { code: 0, stderr: "", stdout: "1\n" };
                    }
                    if (cmd === "git" && args.includes("diff")) {
                        return { code: 0, stderr: "", stdout: "src/added.test.ts\nsrc/app.test.ts\n" };
                    }
                    if (cmd === "git" && args.includes("cat-file")) {
                        const spec = args[args.length - 1] ?? "";
                        // src/added.test.ts is absent in base; everything else is present.
                        return spec === "main:src/added.test.ts"
                            ? { code: 1, stderr: "not found", stdout: "" }
                            : { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "git" && args.includes("checkout")) {
                        checkouts.push(args);
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                        return { code: 0, stderr: "", stdout: "https://gh/pr/99\n" };
                    }
                    return { code: 0, stderr: "", stdout: "" };
                };
                // The gate runs (it is NOT failed open) and the baseline passes.
                const gate: GateExec = async () => ({ exitCode: 0, output: "ok" });
                const result = await runIssue(
                    "CG-42",
                    {},
                    deps({ driver, gateExec: gate, git, prExec: exec, registry: pinnedRegistry(), tracker }),
                );

                // Only the pre-existing test is pinned; the added test never hits `checkout base`.
                const pinned = checkouts.find((c) => c.includes("main"));
                expect(pinned).toBeDefined();
                expect(pinned).toContain("src/app.test.ts");
                expect(pinned).not.toContain("src/added.test.ts");
                // The gate ran and passed → advanced to In Review (not failed open, not red).
                expect(result.applied).toEqual({ movedTo: "In Review" });
            });

            it("no baseline globs: the gate runs in the worktree without any pinning checkout", async () => {
                const tracker = new FakeTracker(implementIssue());
                const { driver } = fakeDriver({ status: "done", summary: "shipped" });
                const { git } = fakeGit();
                const checkouts: string[][] = [];
                const exec: Exec = async (cmd, args): Promise<ExecResult> => {
                    if (cmd === "git" && args.includes("rev-list")) {
                        return { code: 0, stderr: "", stdout: "1\n" };
                    }
                    if (cmd === "git" && args.includes("diff")) {
                        return { code: 0, stderr: "", stdout: "src/app.test.ts\n" };
                    }
                    if (cmd === "git" && args.includes("checkout")) {
                        checkouts.push(args);
                        return { code: 0, stderr: "", stdout: "" };
                    }
                    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                        return { code: 0, stderr: "", stdout: "https://gh/pr/99\n" };
                    }
                    return { code: 0, stderr: "", stdout: "" };
                };
                const gate: GateExec = async () => ({ exitCode: 0, output: "ok" });
                const reg = beflowRegistry({ evaluator: "off" });
                const gated: Registry = {
                    ...reg,
                    projects: {
                        ...reg.projects,
                        CG: { ...reg.projects.CG!, qualityGate: { commands: ["bun test"] } },
                    },
                };
                const result = await runIssue(
                    "CG-42",
                    {},
                    deps({ driver, gateExec: gate, git, prExec: exec, registry: gated, tracker }),
                );

                expect(checkouts).toHaveLength(0);
                expect(result.applied).toEqual({ movedTo: "In Review" });
            });
        });
    });
});

describe("runSupervised", () => {
    function deps(over: Partial<RunSupervisedDeps> & { tracker: Tracker }): RunSupervisedDeps {
        return {
            clock: fixedClock,
            config,
            prompts,
            registry,
            runsFs: memRunsFs().fs,
            ...over,
        };
    }

    it("ensures the session before launching, then writes back", async () => {
        const tracker = new FakeTracker(makeIssue());
        const launched: string[] = [];
        const callOrder: string[] = [];
        const result = await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done", prUrl: "http://pr/2" }),
                ensureSession: async () => {
                    callOrder.push("ensure");
                },
                launchInteractive: async (l) => {
                    callOrder.push("launch");
                    launched.push(l.sessionKey);
                },
                runsFs: memRunsFs().fs,
                tracker,
            }),
        );

        expect(callOrder).toEqual(["ensure", "launch"]);
        expect(launched).toEqual(["CG-42"]);
        expect(result.report.status).toBe("done");
        expect(result.applied.movedTo).toBe("In Review");

        const order = tracker.calls.map((c) => c.kind);
        expect(order[0]).toBe("updateState"); // In Progress first
        expect(tracker.calls).toContainEqual({
            key: "CG-42",
            kind: "linkPR",
            url: "http://pr/2",
        });
    });

    it("assigns the configured user after moving to In Progress", async () => {
        const tracker = new FakeTracker(makeIssue());
        const cfg: Config = { ...config, assignee: "u-1" };
        await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                config: cfg,
                launchInteractive: async () => {},
                tracker,
            }),
        );

        const moveIdx = tracker.calls.findIndex((c) => c.kind === "updateState" && c.state === "In Progress");
        const assignIdx = tracker.calls.findIndex((c) => c.kind === "assign");
        expect(assignIdx).toBeGreaterThan(moveIdx);
        expect(tracker.calls).toContainEqual({
            assignee: "u-1",
            key: "CG-42",
            kind: "assign",
        });
    });

    it("does not assign when no assignee is configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                launchInteractive: async () => {},
                tracker,
            }),
        );
        expect(tracker.calls.some((c) => c.kind === "assign")).toBe(false);
    });

    it("builds a needs_input report from the outcome", async () => {
        const tracker = new FakeTracker(makeIssue());
        const result = await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "needs_input" }),
                launchInteractive: async () => {},
                tracker,
            }),
        );
        expect(result.applied.movedTo).toBe("Needs Input");
    });

    it("persists report and prUrl into the record on a non-done outcome", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs, store } = memRunsFs();
        await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ prUrl: "http://pr/sup", status: "needs_input" }),
                launchInteractive: async () => {},
                runsFs: fs,
                tracker,
            }),
        );
        const rec = onlyRecord(store);
        expect(rec?.status).toBe("needs_input");
        expect(rec?.report?.status).toBe("needs_input");
        expect(rec?.prUrl).toBe("http://pr/sup");
    });

    it("YIELD: a manual move at the re-read skips writeback, comments, and deletes the record", async () => {
        const tracker = new FlipReadTracker({ group: "cancelled", name: "Cancelled" });
        const { fs, store } = memRunsFs();
        const result = await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                launchInteractive: async () => {},
                runsFs: fs,
                tracker,
            }),
        );

        // No writeback state move to In Review (the implement done target).
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
        // The report summary was preserved as a comment.
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("ended with status"))).toBe(true);
        // The record was deleted and nothing was applied.
        expect(store.size).toBe(0);
        expect(result.applied).toEqual({});
    });

    it("NORMAL: a started issue at the re-read writes back as usual", async () => {
        const tracker = new FlipReadTracker({ group: "started", name: "In Progress" });
        const result = await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                launchInteractive: async () => {},
                tracker,
            }),
        );

        expect(result.applied.movedTo).toBe("In Review");
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(true);
    });

    it("MCP: injects .acpxrc.json around the interactive launch and restores it after", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs: mcpFs, store: mcpStore } = memMcpFs();
        const acpxPath = "/repo/bin/.acpxrc.json";
        const prior = JSON.stringify({ approveReads: true });
        mcpStore.set(acpxPath, prior);

        let duringLaunch: string | undefined;
        await runSupervised(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                launchInteractive: async () => {
                    duringLaunch = mcpStore.get(acpxPath);
                },
                mcpFs,
                mcpServers,
                tracker,
            }),
        );

        // The injected file (prior key preserved + mcpServers) was live during the launch...
        expect(JSON.parse(duringLaunch ?? "")).toEqual({ approveReads: true, mcpServers });
        // ...and the exact prior content was restored afterward.
        expect(mcpStore.get(acpxPath)).toBe(prior);
    });
});

describe("runOpen", () => {
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

    it("MCP: never injects an .acpxrc.json into the cwd (native client, not acpx)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "beflow-open-"));
        try {
            const reg: Registry = {
                ...registry,
                projects: { ...registry.projects, CG: { ...registry.projects.CG!, repos: { bin: dir } } },
            };
            const tracker = new FakeTracker(makeIssue());
            await runOpen(
                "CG-42",
                {},
                deps({
                    askOutcome: async () => ({ status: "done" }),
                    openIssue: async () => {},
                    registry: reg,
                    tracker,
                }),
            );
            // runOpen uses the agent's native MCP config; it must leave no managed file.
            expect(existsSync(join(dir, ".acpxrc.json"))).toBe(false);
        } finally {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    it("moves to In Progress then launches the native agent with the task", async () => {
        const tracker = new FakeTracker(makeIssue());
        const launches: OpenLaunch[] = [];
        const order: string[] = [];
        const result = await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => {
                    order.push("outcome");
                    return { status: "done" };
                },
                openIssue: async (l) => {
                    order.push("open");
                    launches.push(l);
                },
                tracker,
            }),
        );

        expect(order).toEqual(["open", "outcome"]);
        expect(tracker.calls[0]).toEqual({
            key: "CG-42",
            kind: "updateState",
            state: "In Progress",
        });
        expect(launches[0]!.command).toBe("claude");
        expect(launches[0]!.args).toEqual([]);
        expect(launches[0]!.cwd).toBe("/repo/bin");
        expect(launches[0]!.task).toContain("CG-42");
        expect(result.applied.movedTo).toBe("In Review");
    });

    it("passes the configured agent command + args to the native launcher", async () => {
        const tracker = new FakeTracker(makeIssue());
        const launches: OpenLaunch[] = [];
        const cfg: Config = {
            ...config,
            agents: { claude: { args: ["--foo"], command: "my-claude" } },
        };
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                config: cfg,
                openIssue: async (l) => {
                    launches.push(l);
                },
                tracker,
            }),
        );
        expect(launches[0]!.command).toBe("my-claude");
        expect(launches[0]!.args).toEqual(["--foo"]);
    });

    it("assigns the configured user after moving to In Progress", async () => {
        const tracker = new FakeTracker(makeIssue());
        const cfg: Config = { ...config, assignee: "u-1" };
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                config: cfg,
                openIssue: async () => {},
                tracker,
            }),
        );
        const moveIdx = tracker.calls.findIndex((c) => c.kind === "updateState" && c.state === "In Progress");
        const assignIdx = tracker.calls.findIndex((c) => c.kind === "assign");
        expect(assignIdx).toBeGreaterThan(moveIdx);
        expect(tracker.calls).toContainEqual({
            assignee: "u-1",
            key: "CG-42",
            kind: "assign",
        });
    });

    it("does not assign when no assignee is configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                openIssue: async () => {},
                tracker,
            }),
        );
        expect(tracker.calls.some((c) => c.kind === "assign")).toBe(false);
    });

    it("a done outcome moves to In Review and deletes the record", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs, store } = memRunsFs();
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );
        expect(store.size).toBe(0);
    });

    it("a non-done outcome saves the record with that status", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs, store } = memRunsFs();
        const result = await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "needs_input" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );
        expect(result.applied.movedTo).toBe("Needs Input");
        expect(onlyRecord(store)?.status).toBe("needs_input");
    });

    it("persists report and prUrl into the record on a non-done outcome", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs, store } = memRunsFs();
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ prUrl: "http://pr/open", status: "blocked" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );
        const rec = onlyRecord(store);
        expect(rec?.status).toBe("blocked");
        expect(rec?.report?.status).toBe("blocked");
        expect(rec?.prUrl).toBe("http://pr/open");
    });

    it("writes a run-record carrying tracker and repoPath", async () => {
        const tracker = new FakeTracker(makeIssue());
        const { fs, store } = memRunsFs();
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "needs_input" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );
        const rec = onlyRecord(store);
        expect(rec?.tracker).toBe("plane");
        expect(rec?.repoPath).toBe("/repo/bin");
    });

    it("throws when the resolved agent is not configured", async () => {
        const tracker = new FakeTracker(makeIssue());
        const cfg: Config = { ...config, agents: {} };
        expect(
            runOpen(
                "CG-42",
                {},
                deps({
                    askOutcome: async () => ({ status: "done" }),
                    config: cfg,
                    openIssue: async () => {},
                    tracker,
                }),
            ),
        ).rejects.toThrow(/agent "claude" is not configured/);
    });

    it("defaultOpenIssue shields SIGINT around the spawn and restores listeners", async () => {
        const before = process.listenerCount("SIGINT");
        const bun = await import("bun");
        const realSpawn = bun.spawn;
        let duringSpawn = -1;
        Reflect.set(bun, "spawn", () => {
            duringSpawn = process.listenerCount("SIGINT");
            return { exited: Promise.resolve(0) };
        });
        try {
            await defaultOpenIssue({
                args: [],
                command: "claude",
                cwd: "/repo/bin",
                task: "do it",
            });
        } finally {
            Reflect.set(bun, "spawn", realSpawn);
        }
        // The shield was installed while the child ran, then removed afterwards.
        expect(duringSpawn).toBe(before + 1);
        expect(process.listenerCount("SIGINT")).toBe(before);
    });

    it("logs pre-TUI operations including moving to In Progress and launching", async () => {
        const tracker = new FakeTracker(makeIssue());
        const lines: string[] = [];
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                log: (m) => {
                    lines.push(m);
                },
                openIssue: async () => {},
                tracker,
            }),
        );
        expect(lines.some((l) => l.includes("moving CG-42 to In Progress"))).toBe(true);
        expect(lines.some((l) => l.includes("launching"))).toBe(true);
    });

    it("passes key and jobKind to askOutcome", async () => {
        const tracker = new FakeTracker(makeIssue());
        let seen: OutcomeContext | undefined;
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async (c) => {
                    seen = c;
                    return { status: "done" };
                },
                openIssue: async () => {},
                tracker,
            }),
        );
        expect(seen?.key).toBe("CG-42");
        expect(seen?.jobKind).toBe("implement");
    });

    it("YIELD: a manual move at the re-read skips writeback, comments, and deletes the record", async () => {
        const tracker = new FlipReadTracker({ group: "cancelled", name: "Cancelled" });
        const { fs, store } = memRunsFs();
        const result = await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );

        // No writeback state move to In Review (the implement done target).
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(false);
        // The report summary was preserved as a comment.
        expect(tracker.calls.some((c) => c.kind === "comment" && c.body.includes("ended with status"))).toBe(true);
        // The record was deleted and nothing was applied.
        expect(store.size).toBe(0);
        expect(result.applied).toEqual({});
    });

    it("NORMAL: a started issue at the re-read writes back as usual", async () => {
        const tracker = new FlipReadTracker({ group: "started", name: "In Progress" });
        const { fs, store } = memRunsFs();
        const result = await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                openIssue: async () => {},
                runsFs: fs,
                tracker,
            }),
        );

        expect(result.applied.movedTo).toBe("In Review");
        expect(tracker.calls.some((c) => c.kind === "updateState" && c.state === "In Review")).toBe(true);
        // A done outcome deletes the record.
        expect(store.size).toBe(0);
    });

    it("appends OPEN_SESSION_TRAILER as the last section of the task passed to openIssue", async () => {
        const tracker = new FakeTracker(makeIssue());
        const launches: OpenLaunch[] = [];
        await runOpen(
            "CG-42",
            {},
            deps({
                askOutcome: async () => ({ status: "done" }),
                openIssue: async (l) => {
                    launches.push(l);
                },
                tracker,
            }),
        );
        expect(launches[0]!.task.endsWith(OPEN_SESSION_TRAILER)).toBe(true);
    });
});

describe("buildInteractiveArgs", () => {
    const fixture: InteractiveLaunch = {
        acpCommand: "claude",
        acpxCommand: ["bunx", "acpx"],
        agent: "claude",
        contract: "/path/to/contract.md",
        cwd: "/path/to/worktree",
        sessionKey: "CG-99",
        task: "implement the feature",
    };

    it("places 'prompt' subcommand immediately before '-s'", () => {
        const args = buildInteractiveArgs(fixture);
        const i = args.indexOf("-s");
        expect(args[i - 1]).toBe("prompt");
    });

    it("places sessionKey immediately after '-s' and task after sessionKey", () => {
        const args = buildInteractiveArgs(fixture);
        const i = args.indexOf("-s");
        expect(args[i + 1]).toBe(fixture.sessionKey);
        expect(args[i + 2]).toBe(fixture.task);
    });

    it("includes --approve-reads, --cwd with cwd, and --agent with acpCommand", () => {
        const args = buildInteractiveArgs(fixture);
        expect(args).toContain("--approve-reads");
        expect(args).toContain("--cwd");
        expect(args[args.indexOf("--cwd") + 1]).toBe(fixture.cwd);
        expect(args).toContain("--agent");
        expect(args[args.indexOf("--agent") + 1]).toBe(fixture.acpCommand);
    });

    it("prefixes the acpxCommand", () => {
        const args = buildInteractiveArgs(fixture);
        expect(args[0]).toBe("bunx");
        expect(args[1]).toBe("acpx");
    });
});
