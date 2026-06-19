import { describe, expect, it } from "bun:test";

import { addProject } from "../src/config/persist.ts";
import type { PersistDeps } from "../src/config/persist.ts";
import { fileSchema } from "../src/config/schema.ts";
import type { Project } from "../src/config/schema.ts";

const existingProject: Project = {
    default_repo: "api",
    defaults: undefined,
    module_repo_map: { GUI: "api" },
    name: "My App",
    plane_project_id: "00000000-0000-4000-8000-000000000003",
    repos: { api: "/path/to/your/project/api" },
    root: "/path/to/your/project",
};

const fixtureConfig = `${JSON.stringify(
    {
        $schema: "./config.schema.json",
        defaults: { agent: "claude", runMode: "supervised" },
        projects: { CG: existingProject },
        tracker: "plane",
        trackers: {
            plane: { apiKeyEnv: "PLANE_API_KEY", baseUrl: "https://api.plane.so", workspaceSlug: "your-workspace" },
        },
        workspace: { id: "00000000-0000-4000-8000-000000000002", slug: "your-workspace" },
    },
    null,
    2,
)}\n`;

const newProject: Project = {
    default_repo: "beflow",
    defaults: undefined,
    module_repo_map: { Core: "beflow" },
    name: "beflow",
    plane_project_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    repos: { beflow: "/home/your-workspace/plane-workflow" },
    root: "/home/your-workspace/plane-workflow",
};

function makeMemoryDeps(initial: string): {
    deps: PersistDeps;
    getWritten: () => { data: string; path: string } | null;
} {
    let written: { data: string; path: string } | null = null;
    const deps: PersistDeps = {
        read: (_path: string) => initial,
        write: (path: string, data: string) => {
            written = { data, path };
        },
    };
    return { deps, getWritten: () => written };
}

describe("addProject", () => {
    it("adds a new project while preserving existing entries and $schema", () => {
        const { deps, getWritten } = makeMemoryDeps(fixtureConfig);

        addProject("/fake/dir", "BF", newProject, deps);

        const result = getWritten();
        expect(result).not.toBeNull();
        if (result === null) {
            return;
        }

        const raw: unknown = JSON.parse(result.data);
        const config = fileSchema.parse(raw);

        expect(config.projects.CG).toBeDefined();
        expect(config.projects.BF).toBeDefined();

        const bf = config.projects.BF;
        if (bf === undefined) {
            return;
        }
        expect(bf.name).toBe("beflow");
        expect(bf.plane_project_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

        expect(typeof raw === "object" && raw !== null && "$schema" in raw).toBe(true);
        if (typeof raw === "object" && raw !== null && "$schema" in raw) {
            expect((raw as { $schema: unknown }).$schema).toBe("./config.schema.json");
        }
    });

    it("produces 2-space indented JSON ending with a newline", () => {
        const { deps, getWritten } = makeMemoryDeps(fixtureConfig);

        addProject("/fake/dir", "BF", newProject, deps);

        const result = getWritten();
        expect(result).not.toBeNull();
        if (result === null) {
            return;
        }

        expect(result.data.endsWith("\n")).toBe(true);
        const lines = result.data.split("\n");
        const firstIndentedLine = lines.find((l) => l.startsWith(" "));
        expect(firstIndentedLine?.startsWith("  ")).toBe(true);
        expect(firstIndentedLine?.startsWith("   ")).toBe(false);
    });

    it("throws when the key already exists", () => {
        const { deps } = makeMemoryDeps(fixtureConfig);

        expect(() => {
            addProject("/fake/dir", "CG", newProject, deps);
        }).toThrow(`beflow: project "CG" already exists in config.json`);
    });

    it("throws from fileSchema.parse when the config is invalid after merge", () => {
        const invalidFixture = `${JSON.stringify(
            {
                defaults: { agent: "claude", runMode: "supervised" },
                projects: { CG: existingProject },
                tracker: "not-a-valid-tracker",
                trackers: {},
                workspace: { id: "w", slug: "your-workspace" },
            },
            null,
            2,
        )}\n`;
        const { deps } = makeMemoryDeps(invalidFixture);

        expect(() => {
            addProject("/fake/dir", "BF", newProject, deps);
        }).toThrow();
    });

    it("passes the correct path to the write dep", () => {
        const { deps, getWritten } = makeMemoryDeps(fixtureConfig);

        addProject("/my/config/dir", "BF", newProject, deps);

        const result = getWritten();
        expect(result).not.toBeNull();
        if (result === null) {
            return;
        }
        expect(result.path).toBe("/my/config/dir/config.json");
    });
});
