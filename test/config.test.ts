import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, loadRegistry } from "../src/config/load.ts";
import { fileSchema } from "../src/config/schema.ts";

const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "beflow-test-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length) {
        const dir = dirs.pop();
        if (dir !== undefined) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

const validFile = {
    agents: {
        claude: { args: ["--dangerously-skip-permissions"], command: "claude-acp" },
    },
    agent: "claude",
    runMode: "supervised",
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
    tracker: "plane",
    trackers: {
        linear: { apiKeyEnv: "LINEAR_API_KEY" },
        plane: {
            apiKeyEnv: "PLANE_API_KEY",
            baseUrl: "https://plane.example",
            workspaceSlug: "your-workspace",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
} as const;

describe("loadConfig", () => {
    it("returns the config slice (tracker, defaults, agents) from config.json", () => {
        const dir = tmp();
        writeFileSync(join(dir, "config.json"), JSON.stringify(validFile));
        const config = loadConfig(dir);
        expect(config.tracker).toBe("plane");
        expect(config.agent).toBe("claude");
        expect(config.agents.claude?.args).toEqual(["--dangerously-skip-permissions"]);
        // The registry slice is not part of Config.
        expect("workspace" in config).toBe(false);
        expect("projects" in config).toBe(false);
    });

    it("defaults agents to {} when the section is absent", () => {
        const dir = tmp();
        const noAgents = (({ agents: _agents, ...rest }) => rest)(validFile);
        writeFileSync(join(dir, "config.json"), JSON.stringify(noAgents));
        expect(loadConfig(dir).agents).toEqual({});
    });

    it("throws a useful message on invalid config (bad runMode)", () => {
        const dir = tmp();
        const bad = { ...validFile, runMode: "attended" };
        writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
        expect(() => loadConfig(dir)).toThrow(/config\.json failed validation/);
    });

    it("throws on missing config.json", () => {
        expect(() => loadConfig(tmp())).toThrow(/cannot read config file/);
    });

    it("throws on malformed JSON", () => {
        const dir = tmp();
        writeFileSync(join(dir, "config.json"), "{ not json");
        expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
    });
});

describe("loadRegistry", () => {
    it("returns the registry slice (workspace + projects) from config.json", () => {
        const dir = tmp();
        writeFileSync(join(dir, "config.json"), JSON.stringify(validFile));
        const registry = loadRegistry(dir);
        expect(registry.workspace.slug).toBe("your-workspace");
        expect(registry.projects.CG?.default_repo).toBe("bin");
    });

    it("the shipped config.example.json parses against fileSchema", () => {
        // import.meta.dir is test/, so the project root is one level up.
        const root = join(import.meta.dir, "..");
        const raw: unknown = JSON.parse(readFileSync(join(root, "config.example.json"), "utf8"));
        const parsed = fileSchema.safeParse(raw);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.workspace.slug).toBe("your-workspace");
            expect(parsed.data.projects.APP?.default_repo).toBe("main_repo");
        }
    });

    it("throws on missing config.json", () => {
        expect(() => loadRegistry(tmp())).toThrow(/cannot read config file/);
    });
});
