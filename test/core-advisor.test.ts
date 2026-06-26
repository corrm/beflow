import { describe, expect, it } from "bun:test";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { Report } from "../src/agent/report.ts";
import type { AdvisorConfig, Config, Registry } from "../src/config/schema.ts";
import type { NotifyEvent, Notifier } from "../src/core/notify.ts";
import { loadPromptSet } from "../src/core/prompts.ts";
import type { RunIssueDeps } from "../src/core/run.ts";
import { runIssue } from "../src/core/run.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    Comment,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    ProjectCreateResult,
    QueueFilter,
    Tracker,
} from "../src/trackers/tracker.ts";

const prompts = loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });

function baseConfig(advisor?: AdvisorConfig): Config {
    return {
        agent: "claude",
        agents: { claude: { command: "claude" } },
        onManualMove: "yield",
        runMode: "autonomous",
        runs: { dir: "/runs" },
        tracker: "plane",
        trackers: {},
        worktrees: { dir: "/wt" },
        ...(advisor !== undefined ? { advisor } : {}),
    };
}

// CG project owns the PR via beflow against a concrete base branch, so the run
// reaches the post-turn advisor with a committed diff and no `gh` base detection.
const registry: Registry = {
    projects: {
        CG: {
            default_repo: "bin",
            module_repo_map: {},
            name: "My App",
            plane_project_id: "pid",
            policy: { evaluator: "off" },
            pr: { baseBranch: "main", owner: "beflow" },
            repos: { bin: "/repo/bin" },
            root: "/root",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

function implementIssue(): Issue {
    return {
        areas: [],
        body: "do the thing",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: { jobKind: "implement", runMode: "autonomous" },
        state: { group: "unstarted", name: "Todo" },
        title: "Crash",
        type: "Bug",
    };
}

// A tracker whose getIssue always reports a started-group issue (so the run never
// yields to a manual move); only the --auto methods carry behavior, the rest are
// inert stubs to satisfy the full Tracker surface.
class FakeTracker implements Tracker {
    comments: { key: string; body: string }[] = [];
    states: string[] = [];
    properties: string[] = [];
    constructor(private readonly issue: Issue) {}
    async getIssue(): Promise<Issue> {
        return { ...this.issue, state: { group: "started", name: "In Progress" } };
    }
    async updateState(_issue: Issue, state: string): Promise<void> {
        this.states.push(state);
    }
    async comment(issue: Issue, body: string): Promise<void> {
        this.comments.push({ body, key: issue.key });
    }
    async addProperty(_issue: Issue, name: string): Promise<void> {
        this.properties.push(name);
    }
    async assign(): Promise<void> {}
    async removeProperty(): Promise<void> {}
    async listComments(): Promise<Comment[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [], parent: undefined };
    }
    async linkPR(): Promise<void> {}
    readMetadata(): IssueMeta {
        return {};
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async createIssue(): Promise<Issue> {
        return this.issue;
    }
    async listQueue(_filter: QueueFilter): Promise<Issue[]> {
        return [];
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
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
        return {};
    }
    async findProjectId(): Promise<string | null> {
        return null;
    }
    async verifyAuth(): Promise<void> {}
}

function verdictText(severity: string, note: string): string {
    return `\`\`\`beflow-advisor\n${JSON.stringify({ note, severity })}\n\`\`\``;
}

// Driver keyed by session: the deputy (`CG-42-advisor`) returns the next scripted
// verdict text per review; the doer (`CG-42`) reports `done` on its initial
// dispatch (so the advisor engages) and on each re-dispatch returns the next entry
// of `reDispatchReports`, defaulting to `done` once that list is exhausted.
function keyedDriver(
    verdicts: string[],
    reDispatchReports: (Report | null)[] = [],
): { driver: AgentDriver; doerRuns: RunOptions[]; advisorRuns: RunOptions[] } {
    const doerRuns: RunOptions[] = [];
    const advisorRuns: RunOptions[] = [];
    let v = 0;
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            if (opts.sessionKey.endsWith("-advisor")) {
                advisorRuns.push(opts);
                const text = verdicts[v++] ?? "";
                return {
                    exitCode: 0,
                    raw: [],
                    report: null,
                    stream: { assistantText: text, toolCalls: [] },
                    timedOut: false,
                };
            }
            doerRuns.push(opts);
            const reDispatch = doerRuns.length - 1; // 0 = initial dispatch, ≥1 = re-dispatch
            const report: Report | null =
                reDispatch > 0 && reDispatch <= reDispatchReports.length
                    ? reDispatchReports[reDispatch - 1]!
                    : { status: "done", summary: "done" };
            return {
                exitCode: 0,
                raw: [],
                report,
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };
    return { advisorRuns, doerRuns, driver };
}

function prGit(): Exec {
    return async (cmd, args): Promise<ExecResult> => {
        if (cmd === "git" && args.includes("rev-list")) {
            return { code: 0, stderr: "", stdout: "1\n" };
        }
        if (cmd === "git" && args.includes("diff")) {
            return { code: 0, stderr: "", stdout: "diff --git a/x b/x\n" };
        }
        if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
            return { code: 0, stderr: "", stdout: "https://gh/pr/1\n" };
        }
        return { code: 0, stderr: "", stdout: "" };
    };
}

function memRunsFs(): RunStoreFs {
    const store = new Map<string, string>();
    return {
        append: (p, d) => {
            store.set(p, `${store.get(p) ?? ""}${d}`);
        },
        list: (dir) => [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
        read: (p) => store.get(p) ?? null,
        remove: (p) => {
            store.delete(p);
        },
        write: (p, d) => {
            store.set(p, d);
        },
    };
}

function captureNotify(): { notify: Notifier; events: NotifyEvent[] } {
    const events: NotifyEvent[] = [];
    return {
        events,
        notify: {
            notify: async (e) => {
                events.push(e);
            },
        },
    };
}

function deps(over: Partial<RunIssueDeps> & { tracker: Tracker; driver: AgentDriver }): RunIssueDeps {
    return {
        clock: () => "2026-06-25T00:00:00.000Z",
        config: baseConfig(),
        git: prGit(),
        pathExists: () => false,
        prExec: prGit(),
        prompts,
        registry,
        runsFs: memRunsFs(),
        ...over,
    };
}

const fullAdvisor: AdvisorConfig = {
    agents: ["claude"],
    enabled: true,
    maxNudges: 2,
};

describe("advisor wiring", () => {
    it("disabled = exact no-op (only the doer run, no advisor session)", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { driver, doerRuns, advisorRuns } = keyedDriver([verdictText("blocker", "x")]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(), driver, tracker }));

        expect(doerRuns).toHaveLength(1);
        expect(advisorRuns).toHaveLength(0);
    });

    it("aside: deputy reviews once, no re-dispatch, run proceeds to In Review", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { driver, doerRuns, advisorRuns } = keyedDriver([verdictText("aside", "looks good")]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, tracker }));

        expect(doerRuns).toHaveLength(1);
        expect(advisorRuns).toHaveLength(1);
        expect(tracker.states).toContain("In Review");
    });

    it("concern: re-dispatches the agent with the correction, then accepts on a clean re-review", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { driver, doerRuns, advisorRuns } = keyedDriver([
            verdictText("concern", "fix the edge case"),
            verdictText("aside", "now correct"),
        ]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, tracker }));

        // One re-dispatch of the doer (2 doer runs), carrying the correction text.
        expect(doerRuns).toHaveLength(2);
        expect(doerRuns[1]!.task).toContain("fix the edge case");
        expect(advisorRuns).toHaveLength(2);
        expect(tracker.states).toContain("In Review");
    });

    it("nudge counter escalates after maxNudges re-dispatches", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { notify, events } = captureNotify();
        // maxNudges = 2: concern, concern, then a third concern that exceeds the cap.
        const { driver, doerRuns } = keyedDriver([
            verdictText("concern", "c1"),
            verdictText("concern", "c2"),
            verdictText("concern", "c3"),
        ]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, notify, tracker }));

        // Two re-dispatches (nudges 1 and 2), then the 3rd concern escalates.
        expect(doerRuns).toHaveLength(3);
        expect(tracker.states).toContain("Needs Input");
        expect(events.some((e) => e.reason === "needs_input" && e.detail === "c3")).toBe(true);
    });

    it("blocker escalates immediately (no re-dispatch)", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { notify, events } = captureNotify();
        const { driver, doerRuns } = keyedDriver([verdictText("blocker", "deletes prod data")]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, notify, tracker }));

        expect(doerRuns).toHaveLength(1);
        expect(tracker.states).toContain("Needs Input");
        expect(events.some((e) => e.reason === "needs_input" && e.detail === "deletes prod data")).toBe(true);
    });

    it("concern re-dispatch that returns a NULL report escalates (no silent drop)", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { notify, events } = captureNotify();
        // First doer run: done. Concern → re-dispatch → second doer run emits no report.
        const { driver, doerRuns } = keyedDriver([verdictText("concern", "fix it")], [null]);
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, notify, tracker }));

        // First done + one re-dispatch that returned null — and we escalate, not fall through.
        expect(doerRuns).toHaveLength(2);
        expect(tracker.states).toContain("Needs Input");
        expect(
            events.some((e) => e.reason === "needs_input" && e.detail?.includes("no report after an advisor") === true),
        ).toBe(true);
    });

    it("concern re-dispatch returning a real needs_input report routes normally (not overridden)", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { notify, events } = captureNotify();
        // The re-dispatch yields the agent's OWN needs_input report, carrying its question.
        const { driver, doerRuns } = keyedDriver(
            [verdictText("concern", "fix it")],
            [{ questions: ["which schema?"], status: "needs_input", summary: "agent has a question" }],
        );
        await runIssue("CG-42", {}, deps({ config: baseConfig(fullAdvisor), driver, notify, tracker }));

        expect(doerRuns).toHaveLength(2);
        expect(tracker.states).toContain("Needs Input");
        // The agent's own question survives — the advisor did not override it.
        expect(events.some((e) => e.reason === "needs_input" && e.detail?.includes("which schema?") === true)).toBe(
            true,
        );
    });

    it("enabled with an agent absent from config.agents: skips cleanly, no throw, → In Review", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { driver, doerRuns, advisorRuns } = keyedDriver([verdictText("blocker", "should never run")]);
        const result = await runIssue(
            "CG-42",
            {},
            deps({ config: baseConfig({ agents: ["ghost"], enabled: true }), driver, tracker }),
        );

        expect(doerRuns).toHaveLength(1);
        expect(advisorRuns).toHaveLength(0);
        expect(result.applied).toEqual({ movedTo: "In Review" });
        expect(tracker.states).toContain("In Review");
    });

    it("enabled with an empty agents list: skips cleanly, no throw, → In Review", async () => {
        const tracker = new FakeTracker(implementIssue());
        const { driver, doerRuns, advisorRuns } = keyedDriver([verdictText("blocker", "should never run")]);
        const result = await runIssue(
            "CG-42",
            {},
            deps({ config: baseConfig({ agents: [], enabled: true }), driver, tracker }),
        );

        expect(doerRuns).toHaveLength(1);
        expect(advisorRuns).toHaveLength(0);
        expect(result.applied).toEqual({ movedTo: "In Review" });
    });
});
