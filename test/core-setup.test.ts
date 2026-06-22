import { describe, expect, it, mock } from "bun:test";

import type { Project, Registry } from "../src/config/schema.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import type { AskProjectSpec } from "../src/core/setup.ts";
import { requiredText, setupProject, updateProject } from "../src/core/setup.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    BoardTemplate,
    Comment,
    EnsureBoardOptions,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ProjectCreateResult,
    ProjectCreateSpec,
    QueueFilter,
    ResolveModuleChanges,
    Tracker,
} from "../src/trackers/tracker.ts";

function memScaffoldFs(seed: Record<string, string> = {}): RunStoreFs & { files: Map<string, string> } {
    const files = new Map<string, string>(Object.entries(seed));
    return {
        files,
        list: () => [],
        read: (p) => files.get(p) ?? null,
        remove: (p) => {
            files.delete(p);
        },
        append: (p, d) => {
            files.set(p, (files.get(p) ?? "") + d);
        },
        write: (p, d) => {
            files.set(p, d);
        },
    };
}

const registry: Registry = {
    projects: {
        CG: {
            default_repo: "bin",
            module_repo_map: { GUI: "bin", Website: "web" },
            name: "My App",
            plane_project_id: "pid",
            repos: { bin: "/repo/bin" },
            root: "/root",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

class RecordingTracker implements Tracker {
    ensureBoardCalls: {
        project: string;
        template: BoardTemplate;
        opts?: EnsureBoardOptions;
    }[] = [];
    verifyAuthError?: Error;
    constructor(private readonly result: EnsureBoardResult) {}
    async verifyAuth(): Promise<void> {
        if (this.verifyAuthError !== undefined) {
            throw this.verifyAuthError;
        }
    }
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
    async inspectBoard(): Promise<BoardState> {
        return { labels: [], modules: [], states: [], types: [] };
    }
    async ensureBoard(project: string, template: BoardTemplate, opts?: EnsureBoardOptions): Promise<EnsureBoardResult> {
        this.ensureBoardCalls.push({ project, template, ...(opts ? { opts } : {}) });
        return this.result;
    }
    createProjectCalls: ProjectCreateSpec[] = [];
    async createProject(spec: ProjectCreateSpec): Promise<ProjectCreateResult> {
        this.createProjectCalls.push(spec);
        return { trackerProjectId: "new-proj-id" };
    }
    foundProjectId: string | null = null;
    findProjectIdCalls: string[] = [];
    async findProjectId(identifier: string): Promise<string | null> {
        this.findProjectIdCalls.push(identifier);
        return this.foundProjectId;
    }
}

describe("setupProject", () => {
    it("calls ensureBoard with the beflow template and returns the result", async () => {
        const tracker = new RecordingTracker({
            created: ["state:In Review"],
            orphans: [],
            pruned: [],
            skipped: ["state:Todo"],
            updated: [],
            warnings: [],
        });
        const result = await setupProject("CG", {
            agents: ["claude"],
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.ensureBoardCalls).toHaveLength(1);
        const call = tracker.ensureBoardCalls[0]!;
        expect(call.project).toBe("CG");
        expect(call.template.states).toHaveLength(7);
        expect(call.template.modules.map((m) => m.name)).toEqual(["GUI", "Website"]);
        expect(result.created).toEqual(["state:In Review"]);
    });

    it("surfaces created/skipped counts and each warning verbatim in the log", async () => {
        const tracker = new RecordingTracker({
            created: ["state:In Review", "type:Bug"],
            orphans: [],
            pruned: [],
            skipped: ["state:Todo"],
            updated: ["label:blocked"],
            warnings: ["work-item-types feature toggle is off"],
        });
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(lines.some((l) => l.includes("2 created") && l.includes("1 updated") && l.includes("1 skipped"))).toBe(
            true,
        );
        expect(lines.some((l) => l.includes("work-item-types feature toggle is off"))).toBe(true);
    });

    it("warns per orphan and does not prune when prune is false", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: ["module:OldName", "label:agent:oldagent"],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            prune: false,
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        const call = tracker.ensureBoardCalls[0]!;
        expect(call.opts).toEqual({ prune: false });
        expect(lines.some((l) => l.includes("orphan module:OldName") && l.includes("--prune"))).toBe(true);
        expect(lines.some((l) => l.includes("orphan label:agent:oldagent") && l.includes("--prune"))).toBe(true);
    });

    it("threads prune:true to ensureBoard and does not warn", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: ["module:OldName"],
            pruned: ["module:OldName"],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            prune: true,
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.ensureBoardCalls[0]!.opts).toEqual({ prune: true });
        expect(lines.some((l) => l.includes("orphan module:OldName"))).toBe(false);
        expect(lines.some((l) => l.includes("1 pruned"))).toBe(true);
    });

    it("creates a missing project, persists the entry, mutates the registry, then provisions the board", async () => {
        const tracker = new RecordingTracker({
            created: ["state:In Review"],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const localRegistry: Registry = {
            projects: {},
            workspace: { id: "w", slug: "your-workspace" },
        };
        const cannedEntry: Project = {
            default_repo: "bin",
            module_repo_map: { GUI: "bin" },
            name: "NewProj",
            repos: { bin: "/repo/bin" },
            root: "/root/new",
        };
        const cannedSpec: ProjectCreateSpec = { identifier: "NP", name: "NewProj" };
        const askProjectSpec: AskProjectSpec = async () => ({ entry: { ...cannedEntry }, spec: cannedSpec });
        const persistCalls: { dir: string; key: string; project: Project }[] = [];

        const result = await setupProject("NP", {
            agents: ["claude"],
            askProjectSpec,
            dir: "/cfg",
            persist: (dir, key, project) => {
                persistCalls.push({ dir, key, project });
            },
            registry: localRegistry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.createProjectCalls).toEqual([cannedSpec]);
        expect(persistCalls).toHaveLength(1);
        expect(persistCalls[0]!.dir).toBe("/cfg");
        expect(persistCalls[0]!.key).toBe("NP");
        expect(persistCalls[0]!.project.plane_project_id).toBe("new-proj-id");
        expect(localRegistry.projects.NP?.plane_project_id).toBe("new-proj-id");
        expect(tracker.ensureBoardCalls).toHaveLength(1);
        expect(tracker.ensureBoardCalls[0]!.project).toBe("NP");
        expect(result.created).toEqual(["state:In Review"]);
    });

    it("adopts an existing tracker project when the asker links, skipping createProject", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const localRegistry: Registry = {
            projects: {},
            workspace: { id: "w", slug: "your-workspace" },
        };
        const cannedEntry: Project = {
            default_repo: "main",
            module_repo_map: {},
            name: "NewProj",
            repos: { main: "/repo/main" },
            root: "/root/new",
        };
        const askProjectSpec: AskProjectSpec = async () => ({
            entry: { ...cannedEntry },
            linkedProjectId: "linked-id",
            spec: { identifier: "NP", name: "NewProj" },
        });
        const persistCalls: { key: string; project: Project }[] = [];

        await setupProject("NP", {
            agents: ["claude"],
            askProjectSpec,
            dir: "/cfg",
            persist: (_dir, key, project) => {
                persistCalls.push({ key, project });
            },
            registry: localRegistry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(persistCalls[0]!.project.plane_project_id).toBe("linked-id");
        expect(localRegistry.projects.NP?.plane_project_id).toBe("linked-id");
        expect(tracker.ensureBoardCalls).toHaveLength(1);
    });

    it("throws an actionable error for a missing key with no asker on a non-TTY", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const localRegistry: Registry = {
            projects: {},
            workspace: { id: "w", slug: "your-workspace" },
        };
        const persistCalls: unknown[] = [];

        expect(
            setupProject("ZZ", {
                agents: ["claude"],
                persist: () => {
                    persistCalls.push(true);
                },
                registry: localRegistry,
                tracker,
                trackerName: "plane",
            }),
        ).rejects.toThrow(/project "ZZ" is not in .*config\.json; run setup in an interactive terminal/);

        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(persistCalls).toHaveLength(0);
    });

    it("fails fast when verifyAuth rejects, before any walkthrough or project create", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        tracker.verifyAuthError = new Error("beflow: Plane token invalid");
        const localRegistry: Registry = {
            projects: {},
            workspace: { id: "w", slug: "your-workspace" },
        };
        let askCalls = 0;
        const cannedEntry: Project = {
            default_repo: "bin",
            module_repo_map: {},
            name: "NewProj",
            repos: { bin: "/repo/bin" },
            root: "/root/new",
        };
        const askProjectSpec: AskProjectSpec = async () => {
            askCalls += 1;
            return { entry: { ...cannedEntry }, spec: { identifier: "NP", name: "NewProj" } };
        };

        expect(
            setupProject("NP", {
                agents: ["claude"],
                askProjectSpec,
                persist: () => {},
                registry: localRegistry,
                scaffoldFs: memScaffoldFs(),
                tracker,
                trackerName: "plane",
            }),
        ).rejects.toThrow(/Plane token invalid/);

        expect(askCalls).toBe(0);
        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(0);
    });

    it("leaves the create path untouched for an existing key", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const askProjectSpec: AskProjectSpec = async () => {
            throw new Error("must not be called for an existing key");
        };
        const persistCalls: unknown[] = [];

        await setupProject("CG", {
            agents: ["claude"],
            askProjectSpec,
            persist: () => {
                persistCalls.push(true);
            },
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(persistCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(1);
        expect(tracker.ensureBoardCalls[0]!.project).toBe("CG");
    });

    it("does NOT scaffold AGENTOWNERS unless the agentowners gate is opted in", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const scaffoldFs = memScaffoldFs();
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            registry,
            scaffoldFs,
            tracker,
            trackerName: "plane",
        });

        expect(scaffoldFs.files.get("/repo/bin/.github/AGENTOWNERS")).toBeUndefined();
        expect(lines.some((l) => l.includes("AGENTOWNERS"))).toBe(false);
    });

    it("scaffolds the control-plane AGENTOWNERS into each repo when opted in", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const scaffoldFs = memScaffoldFs();
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            registry,
            scaffoldFs,
            scaffoldOwners: { path: ".github/AGENTOWNERS" },
            tracker,
            trackerName: "plane",
        });

        expect(scaffoldFs.files.get("/repo/bin/.github/AGENTOWNERS")).toContain("AGENTOWNERS");
        expect(lines.some((l) => l.includes("wrote starter AGENTOWNERS"))).toBe(true);
    });

    it("leaves an existing AGENTOWNERS untouched when opted in", async () => {
        const tracker = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const scaffoldFs = memScaffoldFs({ "/repo/bin/.github/AGENTOWNERS": "src/** block\n" });
        const lines: string[] = [];
        await setupProject("CG", {
            agents: ["claude"],
            log: (m) => {
                lines.push(m);
            },
            registry,
            scaffoldFs,
            scaffoldOwners: { path: ".github/AGENTOWNERS" },
            tracker,
            trackerName: "plane",
        });

        expect(scaffoldFs.files.get("/repo/bin/.github/AGENTOWNERS")).toBe("src/** block\n");
        expect(lines.some((l) => l.includes("already present") && l.includes("left untouched"))).toBe(true);
    });

    it("forwards an injected resolveModuleChanges into ensureBoard opts", async () => {
        const t = new RecordingTracker({
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        });
        const resolver: ResolveModuleChanges = async (_change) => ({});
        await setupProject("CG", {
            agents: [],
            registry,
            resolveModuleChanges: resolver,
            scaffoldFs: memScaffoldFs(),
            tracker: t,
            trackerName: "plane",
        });
        const call = t.ensureBoardCalls[0]!;
        expect(call.opts?.resolveModuleChanges).toBe(resolver);
    });
});

describe("updateProject", () => {
    function emptyResult(): EnsureBoardResult {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }

    it("reconciles an existing linked project without creating or persisting", async () => {
        const tracker = new RecordingTracker(emptyResult());
        const persistCalls: unknown[] = [];

        const result = await updateProject("CG", {
            agents: ["claude"],
            persist: () => {
                persistCalls.push(true);
            },
            registry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(persistCalls).toHaveLength(0);
        expect(tracker.findProjectIdCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(1);
        expect(tracker.ensureBoardCalls[0]!.project).toBe("CG");
        expect(result.created).toEqual([]);
    });

    it("never creates: throws when the key is not in config", async () => {
        const tracker = new RecordingTracker(emptyResult());
        expect(
            updateProject("ZZ", {
                agents: ["claude"],
                registry,
                tracker,
                trackerName: "plane",
            }),
        ).rejects.toThrow(/project "ZZ" is not in .*config\.json — run `beflow setup ZZ`/);
        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(0);
    });

    it("resolves and persists the tracker link when plane_project_id is missing", async () => {
        const tracker = new RecordingTracker(emptyResult());
        tracker.foundProjectId = "resolved-id";
        const localRegistry: Registry = {
            projects: {
                NP: {
                    default_repo: "main",
                    module_repo_map: {},
                    name: "NoLink",
                    repos: { main: "/repo/main" },
                    root: "/root",
                },
            },
            workspace: { id: "w", slug: "your-workspace" },
        };
        const persistCalls: { key: string; project: Project }[] = [];

        await updateProject("NP", {
            agents: ["claude"],
            dir: "/cfg",
            persist: (_dir, key, project) => {
                persistCalls.push({ key, project });
            },
            registry: localRegistry,
            scaffoldFs: memScaffoldFs(),
            tracker,
            trackerName: "plane",
        });

        expect(tracker.findProjectIdCalls).toEqual(["NP"]);
        expect(persistCalls[0]!.project.plane_project_id).toBe("resolved-id");
        expect(localRegistry.projects.NP?.plane_project_id).toBe("resolved-id");
        expect(tracker.ensureBoardCalls).toHaveLength(1);
    });

    it("throws when no tracker project matches an unlinked config entry", async () => {
        const tracker = new RecordingTracker(emptyResult());
        tracker.foundProjectId = null;
        const localRegistry: Registry = {
            projects: {
                NP: {
                    default_repo: "main",
                    module_repo_map: {},
                    name: "NoLink",
                    repos: { main: "/repo/main" },
                    root: "/root",
                },
            },
            workspace: { id: "w", slug: "your-workspace" },
        };

        expect(
            updateProject("NP", {
                agents: ["claude"],
                registry: localRegistry,
                scaffoldFs: memScaffoldFs(),
                tracker,
                trackerName: "plane",
            }),
        ).rejects.toThrow(/no plane_project_id and no plane project with identifier "NP"/);
        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(0);
    });

    it("fails fast when verifyAuth rejects", async () => {
        const tracker = new RecordingTracker(emptyResult());
        tracker.verifyAuthError = new Error("beflow: Plane token invalid");
        expect(
            updateProject("CG", {
                agents: ["claude"],
                registry,
                tracker,
                trackerName: "plane",
            }),
        ).rejects.toThrow(/Plane token invalid/);
        expect(tracker.ensureBoardCalls).toHaveLength(0);
    });
});

describe("requiredText", () => {
    it("rejects an empty value when there is no default", () => {
        expect(requiredText("", false)).toBe("Required");
        expect(requiredText("   ", false)).toBe("Required");
        expect(requiredText(undefined, false)).toBe("Required");
    });

    it("accepts an empty value when a default is offered (Enter takes the default)", () => {
        expect(requiredText("", true)).toBeUndefined();
        expect(requiredText("   ", true)).toBeUndefined();
        expect(requiredText(undefined, true)).toBeUndefined();
    });

    it("accepts any non-empty value", () => {
        expect(requiredText("CG", false)).toBeUndefined();
        expect(requiredText("CG", true)).toBeUndefined();
    });
});

describe("defaultAskProjectSpec single-repo Enter-through flow", () => {
    it('defaults the repo key to "main" and its path to the root; skips module prompts with one repo', async () => {
        // Mirror @clack/prompts 1.5.1: text() runs validate on the raw value, then on a
        // bare Enter (empty input) substitutes defaultValue. Scripted inputs drive each prompt.
        const inputs = ["My App", "", "/root/new", "", ""];
        let cursor = 0;
        const confirmAnswers = [false];
        let confirmCursor = 0;

        await mock.module("@clack/prompts", () => ({
            cancel: () => {},
            confirm: async () => confirmAnswers[confirmCursor++] ?? false,
            isCancel: () => false,
            select: async () => {
                throw new Error("select must not be called in the single-repo flow");
            },
            text: async (opts: {
                defaultValue?: string;
                validate?: (v: string | undefined) => string | undefined;
            }): Promise<string> => {
                const typed = inputs[cursor++] ?? "";
                const error = opts.validate?.(typed);
                if (error !== undefined) {
                    throw new Error(`validate rejected ${JSON.stringify(typed)}: ${error}`);
                }
                if (typed === "" && opts.defaultValue !== undefined) {
                    return opts.defaultValue;
                }
                return typed;
            },
        }));

        try {
            const { defaultAskProjectSpec } = await import("../src/core/setup.ts");
            const { entry, spec, linkedProjectId } = await defaultAskProjectSpec({
                findProjectId: async () => null,
                key: "NP",
                tracker: "plane",
            });

            expect(spec).toEqual({ identifier: "NP", name: "My App" });
            expect(entry.name).toBe("My App");
            expect(entry.root).toBe("/root/new");
            expect(entry.default_repo).toBe("main");
            expect(entry.repos).toEqual({ main: "/root/new" });
            expect(entry.module_repo_map).toEqual({});
            expect(linkedProjectId).toBeUndefined();
        } finally {
            mock.restore();
        }
    });

    it("offers to link when the identifier already exists in the tracker, and skips create", async () => {
        const inputs = ["My App", "", "/root/new", "", ""];
        let cursor = 0;
        // confirm sequence: link? -> yes ; "Add another repo?" -> no
        const confirmAnswers = [true, false];
        let confirmCursor = 0;

        await mock.module("@clack/prompts", () => ({
            cancel: () => {},
            confirm: async () => confirmAnswers[confirmCursor++] ?? false,
            isCancel: () => false,
            select: async () => {
                throw new Error("select must not be called");
            },
            text: async (opts: {
                defaultValue?: string;
                validate?: (v: string | undefined) => string | undefined;
            }): Promise<string> => {
                const typed = inputs[cursor++] ?? "";
                if (typed === "" && opts.defaultValue !== undefined) {
                    return opts.defaultValue;
                }
                return typed;
            },
        }));

        try {
            const { defaultAskProjectSpec } = await import("../src/core/setup.ts");
            const findCalls: string[] = [];
            const { spec, linkedProjectId } = await defaultAskProjectSpec({
                findProjectId: async (id) => {
                    findCalls.push(id);
                    return "existing-proj-id";
                },
                key: "NP",
                tracker: "plane",
            });

            expect(findCalls).toEqual(["NP"]);
            expect(spec.identifier).toBe("NP");
            expect(linkedProjectId).toBe("existing-proj-id");
        } finally {
            mock.restore();
        }
    });

    it("re-prompts for a new identifier when the user declines to link", async () => {
        // identifier #1 ("") -> "NP" (taken, decline) ; identifier #2 -> "NP2" (free)
        const inputs = ["My App", "", "NP2", "/root/new", "", ""];
        let cursor = 0;
        // confirm: link "NP"? -> no ; "Add another repo?" -> no
        const confirmAnswers = [false, false];
        let confirmCursor = 0;

        await mock.module("@clack/prompts", () => ({
            cancel: () => {},
            confirm: async () => confirmAnswers[confirmCursor++] ?? false,
            isCancel: () => false,
            select: async () => {
                throw new Error("select must not be called");
            },
            text: async (opts: {
                defaultValue?: string;
                validate?: (v: string | undefined) => string | undefined;
            }): Promise<string> => {
                const typed = inputs[cursor++] ?? "";
                if (typed === "" && opts.defaultValue !== undefined) {
                    return opts.defaultValue;
                }
                return typed;
            },
        }));

        try {
            const { defaultAskProjectSpec } = await import("../src/core/setup.ts");
            const { spec, linkedProjectId } = await defaultAskProjectSpec({
                findProjectId: async (id) => (id === "NP" ? "taken-id" : null),
                key: "NP",
                tracker: "plane",
            });

            expect(spec.identifier).toBe("NP2");
            expect(linkedProjectId).toBeUndefined();
        } finally {
            mock.restore();
        }
    });
});
