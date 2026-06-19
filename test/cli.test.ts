import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import { runCli } from "../src/cli.ts";
import type { CliDeps } from "../src/cli.ts";
import type { Config, Registry } from "../src/config/schema.ts";
import type { OpenLaunch } from "../src/core/run.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
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

const config: Config = {
    agents: { claude: { command: "claude" }, opencode: { command: "opencode" } },
    defaults: { agent: "claude", onManualMove: "yield", runMode: "supervised" },
    runs: { dir: join(tmpdir(), "beflow-cli-test-runs") },
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

function makeIssue(): Issue {
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
    };
}

class FakeTracker implements Tracker {
    metaSeen: IssueMeta = {};
    async getIssue(): Promise<Issue> {
        return makeIssue();
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async createIssue(_project: string, draft: IssueDraft): Promise<Issue> {
        return { ...makeIssue(), key: "CG-NEW", title: draft.title };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(_f: QueueFilter): Promise<Issue[]> {
        return [];
    }
    async updateState(_issue: Issue, _stateName: string): Promise<void> {}
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
    async listInbox(_project: string): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(_project: string, _item: IntakeItem): Promise<void> {}
    async inspectBoard(_project: string): Promise<BoardState> {
        return {
            labels: [
                "blocked",
                "failed",
                "quarantined",
                "triaged",
                "needs-decision",
                "customer-reported",
                "changes-requested",
                "run:autonomous",
                "run:supervised",
                "jobkind:triage",
                "jobkind:spec",
                "jobkind:implement",
                "agent:claude",
                "agent:opencode",
            ],
            modules: [],
            states: ["Backlog", "Todo", "In Progress", "Needs Input", "In Review", "Done", "Cancelled"],
            types: ["Bug", "Feature", "Chore", "Spike"],
        };
    }
    async ensureBoard(_project: string, _template: BoardTemplate): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
}

class UnknownKeyTracker extends FakeTracker {
    async getIssue(): Promise<Issue> {
        throw new Error('plane: unknown project key "ZZ"');
    }
}

class CountingTracker extends FakeTracker {
    getIssueCalls = 0;
    private movedToInProgress = false;
    constructor(private readonly meta: IssueMeta = {}) {
        super();
    }
    override async getIssue(): Promise<Issue> {
        this.getIssueCalls += 1;
        // Mirror the board: after beflow moves the card to In Progress, the live
        // Re-read reports a started state so the run doesn't see a manual pull.
        if (this.movedToInProgress) {
            return { ...makeIssue(), state: { group: "started", name: "In Progress" } };
        }
        return makeIssue();
    }
    override async updateState(_issue: Issue, stateName: string): Promise<void> {
        if (stateName === "In Progress") {
            this.movedToInProgress = true;
        }
    }
    override readMetadata(): IssueMeta {
        return this.meta;
    }
}

class SetupTracker extends FakeTracker {
    ensureBoardCalls: BoardTemplate[] = [];
    async ensureBoard(_project: string, template: BoardTemplate): Promise<EnsureBoardResult> {
        this.ensureBoardCalls.push(template);
        return { created: ["state:In Review"], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
}

class QueueTracker extends FakeTracker {
    filters: QueueFilter[] = [];
    async listQueue(f: QueueFilter): Promise<Issue[]> {
        this.filters.push(f);
        return [{ ...makeIssue(), priority: "high" }];
    }
}

class CreateIssueTracker extends FakeTracker {
    created: { project: string; draft: IssueDraft }[] = [];
    override async createIssue(project: string, draft: IssueDraft): Promise<Issue> {
        this.created.push({ draft, project });
        return { ...makeIssue(), key: "CG-NEW", title: draft.title };
    }
}

class AcceptTracker extends FakeTracker {
    accepted: IntakeItem[] = [];
    async listInbox(): Promise<IntakeItem[]> {
        return [{ body: "", id: "intake-1", issueId: "wi-1", status: 0, title: "raw" }];
    }
    async acceptInbox(_project: string, item: IntakeItem): Promise<void> {
        this.accepted.push(item);
    }
}

interface Harness {
    deps: CliDeps;
    trace: {
        runIssue: RunOptions[];
        supervised: number;
        opened: string[];
        openLaunches: OpenLaunch[];
        watch: { project: string; sleepMs: number }[];
        review: string[];
        logs: string[];
    };
}

function harness(trackerImpl: Tracker = new FakeTracker()): Harness {
    const trace: Harness["trace"] = {
        logs: [],
        openLaunches: [],
        opened: [],
        review: [],
        runIssue: [],
        supervised: 0,
        watch: [],
    };

    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            trace.runIssue.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report: { status: "done", summary: "s" },
                stream: { assistantText: "", toolCalls: [] },
                timedOut: false,
            };
        },
    };

    const deps: CliDeps = {
        askOutcome: async () => ({ status: "done" }),
        createDriver: () => driver,
        createTracker: () => trackerImpl,
        cwd: "/cwd",
        launchInteractive: async () => {
            trace.supervised += 1;
        },
        loadConfig: () => config,
        loadRegistry: () => registry,
        log: (m) => {
            trace.logs.push(m);
        },
        openIssue: async (l) => {
            trace.opened.push(l.cwd);
            trace.openLaunches.push(l);
        },
        runReview: async (key) => {
            trace.review.push(key);
            return { findings: 0, reviewed: true };
        },
        watch: async (project, _deps, ctrl) => {
            trace.watch.push({ project, sleepMs: ctrl.sleepMs });
        },
    };
    return { deps, trace };
}

describe("runCli", () => {
    it("run CG-42 --auto dispatches runIssue (autonomous)", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["run", "CG-42", "--auto"], deps);
        expect(code).toBe(0);
        expect(trace.runIssue).toHaveLength(1);
        expect(trace.runIssue[0]!.runMode).toBe("autonomous");
        expect(trace.supervised).toBe(0);
    });

    it("run CG-42 --attend dispatches runSupervised", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["run", "CG-42", "--attend"], deps);
        expect(code).toBe(0);
        expect(trace.supervised).toBe(1);
        expect(trace.runIssue).toHaveLength(0);
    });

    it("defaults to supervised when neither --auto nor --attend is given", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["run", "CG-42"], deps);
        expect(code).toBe(0);
        expect(trace.supervised).toBe(1);
    });

    it("no flag, meta resolves autonomous → dispatches runIssue", async () => {
        const tracker = new CountingTracker({ runMode: "autonomous" });
        const { deps, trace } = harness(tracker);
        const code = await runCli(["run", "CG-42"], deps);
        expect(code).toBe(0);
        expect(trace.runIssue).toHaveLength(1);
        expect(trace.runIssue[0]!.runMode).toBe("autonomous");
        expect(trace.supervised).toBe(0);
    });

    it("no flag, global default supervised → dispatches runSupervised", async () => {
        const tracker = new CountingTracker();
        const { deps, trace } = harness(tracker);
        const code = await runCli(["run", "CG-42"], deps);
        expect(code).toBe(0);
        expect(trace.supervised).toBe(1);
        expect(trace.runIssue).toHaveLength(0);
    });

    it("--auto overrides a meta-resolved supervised → runIssue", async () => {
        const tracker = new CountingTracker({ runMode: "supervised" });
        const { deps, trace } = harness(tracker);
        const code = await runCli(["run", "CG-42", "--auto"], deps);
        expect(code).toBe(0);
        expect(trace.runIssue).toHaveLength(1);
        expect(trace.supervised).toBe(0);
    });

    it("--attend overrides a meta-resolved autonomous → runSupervised", async () => {
        const tracker = new CountingTracker({ runMode: "autonomous" });
        const { deps, trace } = harness(tracker);
        const code = await runCli(["run", "CG-42", "--attend"], deps);
        expect(code).toBe(0);
        expect(trace.supervised).toBe(1);
        expect(trace.runIssue).toHaveLength(0);
    });

    it("review CG-42 invokes runReview with the key", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["review", "CG-42"], deps);
        expect(code).toBe(0);
        expect(trace.review).toEqual(["CG-42"]);
    });

    it("fetches the issue twice per autonomous run (resolve + live manual-move re-read)", async () => {
        // One fetch resolves the run; a second re-reads the live board state after
        // The agent finishes so beflow can yield to a manual move instead of writing
        // Back over it. (In yield mode no poller runs, so there are no extra fetches.)
        const tracker = new CountingTracker({ runMode: "autonomous" });
        const { deps } = harness(tracker);
        const code = await runCli(["run", "CG-42"], deps);
        expect(code).toBe(0);
        expect(tracker.getIssueCalls).toBe(2);
    });

    it("fails run when the board has drifted (missing In Review)", async () => {
        class DriftedTracker extends CountingTracker {
            override async inspectBoard(): Promise<BoardState> {
                return {
                    labels: ["blocked", "triaged"],
                    modules: [],
                    states: ["Backlog", "Todo", "In Progress", "Needs Input", "Done"],
                    types: [],
                };
            }
        }
        const tracker = new DriftedTracker({ runMode: "autonomous" });
        const { deps, trace } = harness(tracker);
        const logs: string[] = [];
        deps.log = (m) => {
            logs.push(m);
        };
        const code = await runCli(["run", "CG-42"], deps);
        expect(code).toBe(1);
        expect(trace.runIssue).toHaveLength(0);
        expect(trace.supervised).toBe(0);
    });

    it("--open launches the native agent in the resolved repo", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(0);
        expect(trace.opened).toEqual(["/repo/bin"]);
    });

    it("--open drives the supervised lifecycle: move → launch → outcome", async () => {
        const order: string[] = [];
        class LifecycleTracker extends FakeTracker {
            override async updateState(): Promise<void> {
                order.push("updateState");
            }
        }
        const { deps } = harness(new LifecycleTracker());
        deps.openIssue = async (l) => {
            order.push("open");
            void l;
        };
        deps.askOutcome = async () => {
            order.push("askOutcome");
            return { status: "done" };
        };
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(0);
        // Move to In Progress, then native launch, then the outcome prompt
        // (a trailing updateState from the done-writeback may follow).
        expect(order.slice(0, 3)).toEqual(["updateState", "open", "askOutcome"]);
    });

    it("--open is blocked by the board-drift guard", async () => {
        class DriftedTracker extends FakeTracker {
            override async inspectBoard(): Promise<BoardState> {
                return {
                    labels: ["blocked", "triaged"],
                    modules: [],
                    states: ["Backlog", "Todo", "In Progress", "Needs Input", "Done"],
                    types: [],
                };
            }
        }
        const { deps, trace } = harness(new DriftedTracker());
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(1);
        expect(trace.openLaunches).toHaveLength(0);
    });

    it("--open uses the resolved agent command + args from config.agents", async () => {
        const { deps, trace } = harness();
        deps.loadConfig = () => ({
            ...config,
            agents: { claude: { args: ["--dangerously-skip-permissions"], command: "claude" } },
        });
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(0);
        expect(trace.openLaunches[0]!.command).toBe("claude");
        expect(trace.openLaunches[0]!.args).toEqual(["--dangerously-skip-permissions"]);
    });

    it("--open fails when the resolved agent is not configured", async () => {
        const { deps, trace } = harness();
        deps.loadConfig = () => ({ ...config, agents: {} });
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(1);
        expect(trace.openLaunches).toHaveLength(0);
    });

    it("--open honors a custom command from config.agents", async () => {
        const { deps, trace } = harness();
        deps.loadConfig = () => ({
            ...config,
            agents: { claude: { args: ["--foo"], command: "my-claude" } },
        });
        const code = await runCli(["run", "CG-42", "--open"], deps);
        expect(code).toBe(0);
        expect(trace.openLaunches[0]!.command).toBe("my-claude");
        expect(trace.openLaunches[0]!.args).toEqual(["--foo"]);
    });

    it("--agent flows into the resolve overrides", async () => {
        const seen: { acpCommand?: string } = {};
        const tracker = new FakeTracker();
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (opts: RunOptions): Promise<AgentRunResult> => {
                seen.acpCommand = opts.acpCommand;
                return {
                    exitCode: 0,
                    raw: [],
                    report: { status: "done", summary: "s" },
                    stream: { assistantText: "", toolCalls: [] },
                    timedOut: false,
                };
            },
        };
        const deps: CliDeps = {
            createDriver: () => driver,
            createTracker: () => tracker,
            cwd: "/cwd",
            loadConfig: () => config,
            loadRegistry: () => registry,
            log: () => {},
        };
        const code = await runCli(["run", "CG-42", "--auto", "--agent", "opencode"], deps);
        expect(code).toBe(0);
        expect(seen.acpCommand).toBe("opencode");
    });

    it("returns nonzero on a missing key", async () => {
        const { deps } = harness();
        const code = await runCli(["run"], deps);
        expect(code).toBe(1);
    });

    it("returns nonzero on an unknown command", async () => {
        const { deps } = harness();
        const code = await runCli(["nope", "CG-42"], deps);
        expect(code).toBe(1);
    });

    it("returns nonzero when the tracker rejects an unknown key", async () => {
        const { deps } = harness(new UnknownKeyTracker());
        const code = await runCli(["run", "ZZ-1", "--auto"], deps);
        expect(code).toBe(1);
    });
});

describe("runCli help", () => {
    it("--help succeeds without loading config", async () => {
        const { deps } = harness();
        let loadCalls = 0;
        deps.loadConfig = () => {
            loadCalls += 1;
            throw new Error("config must not be loaded for --help");
        };
        const code = await runCli(["--help"], deps);
        expect(code).toBe(0);
        expect(loadCalls).toBe(0);
    });

    it("setup --help succeeds without loading config", async () => {
        const { deps } = harness();
        let loadCalls = 0;
        deps.loadConfig = () => {
            loadCalls += 1;
            throw new Error("config must not be loaded for setup --help");
        };
        const code = await runCli(["setup", "--help"], deps);
        expect(code).toBe(0);
        expect(loadCalls).toBe(0);
    });

    it("no-args prints the command list and returns a defined code", async () => {
        const { deps } = harness();
        let loadCalls = 0;
        deps.loadConfig = () => {
            loadCalls += 1;
            throw new Error("config must not be loaded for the top-level command list");
        };
        const code = await runCli([], deps);
        expect(code).toBeDefined();
        expect(code).toBe(0);
        expect(loadCalls).toBe(0);
    });
});

describe("runCli setup", () => {
    it("setup CG calls the tracker ensureBoard path", async () => {
        const tracker = new SetupTracker();
        const { deps } = harness(tracker);
        const code = await runCli(["setup", "CG"], deps);
        expect(code).toBe(0);
        expect(tracker.ensureBoardCalls).toHaveLength(1);
        expect(tracker.ensureBoardCalls[0]!.states).toHaveLength(7);
    });

    it("returns nonzero when the project is missing", async () => {
        const { deps } = harness();
        const code = await runCli(["setup"], deps);
        expect(code).toBe(1);
    });

    it("passes a de-duped, sorted agent:<name> label set into the template", async () => {
        const tracker = new SetupTracker();
        const { deps } = harness(tracker);
        // Config.defaults.agent is 'claude'; config.agents adds zeta + claude (dup).
        deps.loadConfig = () => ({
            ...config,
            agents: { claude: { command: "claude" }, zeta: { command: "zeta" } },
        });
        const code = await runCli(["setup", "CG"], deps);
        expect(code).toBe(0);
        const labels = tracker.ensureBoardCalls[0]!.labels.map((l) => l.name);
        expect(labels).toContain("agent:claude");
        expect(labels).toContain("agent:zeta");
        // De-duped: claude appears exactly once even though it's in both sources.
        expect(labels.filter((n) => n === "agent:claude")).toHaveLength(1);
        // Sorted: claude before zeta.
        expect(labels.indexOf("agent:claude")).toBeLessThan(labels.indexOf("agent:zeta"));
    });
});

describe("runCli queue", () => {
    it("prints rows for the queue", async () => {
        const tracker = new QueueTracker();
        const { deps, trace } = harness(tracker);
        const code = await runCli(["queue", "--project", "CG"], deps);
        expect(code).toBe(0);
        expect(trace.logs.some((l) => l.includes("CG-42"))).toBe(true);
        expect(tracker.filters[0]!.project).toBe("CG");
    });

    it("passes --state through to the filter", async () => {
        const tracker = new QueueTracker();
        const { deps } = harness(tracker);
        const code = await runCli(["queue", "--project", "CG", "--state", "In Review"], deps);
        expect(code).toBe(0);
        expect(tracker.filters.every((f) => f.state === "In Review")).toBe(true);
    });
});

describe("runCli runs", () => {
    function runsFs(records: Record<string, unknown>): RunStoreFs {
        const store = new Map<string, string>();
        for (const [key, rec] of Object.entries(records)) {
            store.set(join(config.runs!.dir, `${key}.json`), JSON.stringify(rec));
        }
        return {
            list: (dir) => [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
            read: (path) => store.get(path) ?? null,
            remove: (path) => {
                store.delete(path);
            },
            write: (path, data) => {
                store.set(path, data);
            },
        };
    }

    function record(over: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            agent: "claude",
            cwd: "/wt/cg-42",
            jobKind: "implement",
            key: "CG-42",
            runMode: "autonomous",
            sessionName: "CG-42",
            status: "done",
            updatedAt: "2026-06-14T00:00:00.000Z",
            ...over,
        };
    }

    it("lists all records read-only (no tracker mutation)", async () => {
        const tracker = new CountingTracker();
        const { deps, trace } = harness(tracker);
        deps.runsFs = runsFs({
            "cg-1": record({ key: "CG-1", usage: { totalTokens: 50 } }),
            "cg-2": record({ key: "CG-2", status: "failed" }),
        });
        const code = await runCli(["runs"], deps);
        expect(code).toBe(0);
        expect(trace.logs.some((l) => l.includes("CG-1") && l.includes("50 tok"))).toBe(true);
        expect(trace.logs.some((l) => l.includes("CG-2") && l.includes("failed"))).toBe(true);
        expect(tracker.getIssueCalls).toBe(0);
    });

    it("prints detail for a single key including tokens and resolved model", async () => {
        const { deps, trace } = harness();
        deps.loadConfig = () => ({
            ...config,
            agents: { claude: { command: "claude", model: "sonnet" } },
        });
        deps.runsFs = runsFs({ "cg-42": record({ usage: { totalTokens: 140 } }) });
        const code = await runCli(["runs", "CG-42"], deps);
        expect(code).toBe(0);
        expect(trace.logs.some((l) => l === "key: CG-42")).toBe(true);
        expect(trace.logs.some((l) => l === "tokens: 140")).toBe(true);
        expect(trace.logs.some((l) => l === "model: sonnet")).toBe(true);
    });

    it("fails when the key has no record", async () => {
        const { deps } = harness();
        deps.runsFs = runsFs({});
        const code = await runCli(["runs", "CG-99"], deps);
        expect(code).toBe(1);
    });

    it("reports an empty store", async () => {
        const { deps, trace } = harness();
        deps.runsFs = runsFs({});
        const code = await runCli(["runs"], deps);
        expect(code).toBe(0);
        expect(trace.logs.some((l) => l.includes("no run records"))).toBe(true);
    });
});

describe("runCli accept", () => {
    it("accept CG <id> calls the accept path", async () => {
        const tracker = new AcceptTracker();
        const { deps } = harness(tracker);
        const code = await runCli(["accept", "CG", "intake-1"], deps);
        expect(code).toBe(0);
        expect(tracker.accepted.map((i) => i.id)).toEqual(["intake-1"]);
    });

    it("returns nonzero on an unknown intake id", async () => {
        const tracker = new AcceptTracker();
        const { deps } = harness(tracker);
        const code = await runCli(["accept", "CG", "nope"], deps);
        expect(code).toBe(1);
    });
});

describe("runCli new", () => {
    it("creates a work item from the generic template with the injected answers", async () => {
        const tracker = new CreateIssueTracker();
        const { deps } = harness(tracker);
        deps.askQuestions = async () => ({ context: "ran into a wall", summary: "Fix login" });
        deps.askConfirm = async () => true;
        const code = await runCli(["new", "CG", "generic"], deps);
        expect(code).toBe(0);
        expect(tracker.created).toHaveLength(1);
        expect(tracker.created[0]!.project).toBe("CG");
        expect(tracker.created[0]!.draft.title).toBe("Fix login");
        expect(tracker.created[0]!.draft.body).toContain("Fix login");
        expect(tracker.created[0]!.draft.body).toContain("ran into a wall");
    });

    it("does not create when the confirmation is declined", async () => {
        const tracker = new CreateIssueTracker();
        const { deps } = harness(tracker);
        deps.askQuestions = async () => ({ context: "", summary: "Fix login" });
        deps.askConfirm = async () => false;
        const code = await runCli(["new", "CG", "generic"], deps);
        expect(code).toBe(0);
        expect(tracker.created).toHaveLength(0);
    });
});

describe("runCli doctor", () => {
    it("prints checks and returns 0 when all pass", async () => {
        const { deps, trace } = harness();
        const healthy: Config = {
            ...config,
            trackers: {
                plane: {
                    apiKeyEnv: "BEFLOW_TEST_KEY",
                    baseUrl: "https://api.plane.so",
                    workspaceSlug: "your-workspace",
                },
            },
        };
        process.env.BEFLOW_TEST_KEY = "token";
        deps.loadConfig = () => healthy;
        deps.fileExists = () => true;
        deps.onPath = () => true;
        try {
            const code = await runCli(["doctor"], { ...deps, cwd: "/cwd" });
            expect(code).toBe(0);
            expect(trace.logs.some((l) => l.includes("config.json"))).toBe(true);
        } finally {
            delete process.env.BEFLOW_TEST_KEY;
        }
    });

    it("returns 1 when a check fails (acpx missing)", async () => {
        const { deps } = harness();
        deps.fileExists = () => true;
        deps.onPath = (cmd) => cmd !== "acpx";
        const code = await runCli(["doctor"], deps);
        expect(code).toBe(1);
    });

    it("returns 1 when config fails to load", async () => {
        const { deps } = harness();
        deps.loadConfig = () => {
            throw new Error("bad config");
        };
        deps.fileExists = () => true;
        deps.onPath = () => true;
        const code = await runCli(["doctor"], deps);
        expect(code).toBe(1);
    });

    it("--ping runs the injected ping when core checks pass", async () => {
        const { deps, trace } = harness();
        const pingConfig: Config = {
            ...config,
            trackers: {
                plane: {
                    apiKeyEnv: "BEFLOW_TEST_KEY",
                    baseUrl: "https://api.plane.so",
                    workspaceSlug: "your-workspace",
                },
            },
        };
        process.env.BEFLOW_TEST_KEY = "token";
        deps.loadConfig = () => pingConfig;
        deps.fileExists = () => true;
        deps.onPath = () => true;
        deps.ping = async () => "reached plane; 0 Todo item(s) in CG";
        try {
            const code = await runCli(["doctor", "--ping"], deps);
            expect(code).toBe(0);
            expect(trace.logs.some((l) => l.includes("live ping") && l.includes("reached"))).toBe(true);
        } finally {
            delete process.env.BEFLOW_TEST_KEY;
        }
    });
});

describe("runCli watch", () => {
    it("invokes the injected watch runner with the project and parsed interval", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["watch", "CG", "--interval", "10"], deps);
        expect(code).toBe(0);
        expect(trace.watch).toEqual([{ project: "CG", sleepMs: 10000 }]);
    });

    it("defaults to a 30s interval", async () => {
        const { deps, trace } = harness();
        const code = await runCli(["watch", "CG"], deps);
        expect(code).toBe(0);
        expect(trace.watch).toEqual([{ project: "CG", sleepMs: 30000 }]);
    });

    it("returns nonzero when the project is missing", async () => {
        const { deps } = harness();
        const code = await runCli(["watch"], deps);
        expect(code).toBe(1);
    });
});

describe("runCli gc", () => {
    it("fails clearly when no git executor is configured", async () => {
        const { deps } = harness();
        const code = await runCli(["gc"], { ...deps, git: undefined });
        expect(code).toBe(1);
    });

    it("rejects a non-positive --older-than", async () => {
        const { deps } = harness();
        const code = await runCli(["gc", "--older-than", "0"], {
            ...deps,
            git: async () => ({ code: 0, stderr: "", stdout: "" }),
        });
        expect(code).toBe(1);
    });

    it("report-only over an empty worktrees dir returns 0 and logs a summary", async () => {
        const { deps, trace } = harness();
        deps.loadConfig = () => ({ ...config, worktrees: { dir: join(tmpdir(), "beflow-gc-empty-test") } });
        const code = await runCli(["gc"], {
            ...deps,
            git: async () => ({ code: 0, stderr: "", stdout: "" }),
        });
        expect(code).toBe(0);
        expect(trace.logs.some((l) => l.includes("orphan worktree(s)"))).toBe(true);
    });
});
