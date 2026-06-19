import { describe, expect, it } from "bun:test";

import type { Project, Registry } from "../src/config/schema.ts";
import type { AskProjectSpec } from "../src/core/setup.ts";
import { setupProject } from "../src/core/setup.ts";
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
    constructor(private readonly result: EnsureBoardResult) {}
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
        const result = await setupProject("CG", { agents: ["claude"], registry, tracker, trackerName: "plane" });

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
            tracker,
            trackerName: "plane",
        });

        expect(tracker.createProjectCalls).toHaveLength(0);
        expect(persistCalls).toHaveLength(0);
        expect(tracker.ensureBoardCalls).toHaveLength(1);
        expect(tracker.ensureBoardCalls[0]!.project).toBe("CG");
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
            tracker: t,
            trackerName: "plane",
        });
        const call = t.ensureBoardCalls[0]!;
        expect(call.opts?.resolveModuleChanges).toBe(resolver);
    });
});
