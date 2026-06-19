import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { zodToJsonSchema } from "zod-to-json-schema";

import { fileSchema } from "../src/config/schema.ts";

const baseFile = {
    agents: {},
    defaults: { agent: "claude", runMode: "supervised" as const },
    projects: {},
    tracker: "plane" as const,
    trackers: {},
    workspace: { id: "w", slug: "your-workspace" },
};

describe("defaults.onManualMove", () => {
    it("defaults to yield when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.onManualMove).toBe("yield");
    });

    it("accepts an explicit abort", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, onManualMove: "abort" },
        });
        expect(parsed.defaults.onManualMove).toBe("abort");
    });

    it("rejects an invalid value", () => {
        const result = fileSchema.safeParse({
            ...baseFile,
            defaults: { ...baseFile.defaults, onManualMove: "fight" },
        });
        expect(result.success).toBe(false);
    });
});

describe("mcp.enabled", () => {
    it("leaves mcp undefined when the section is omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.mcp).toBeUndefined();
    });

    it("defaults enabled to false when mcp is present but enabled omitted", () => {
        const parsed = fileSchema.parse({ ...baseFile, mcp: {} });
        expect(parsed.mcp?.enabled).toBe(false);
    });

    it("parses an explicit enabled: true", () => {
        const parsed = fileSchema.parse({ ...baseFile, mcp: { enabled: true } });
        expect(parsed.mcp?.enabled).toBe(true);
    });
});

describe("project limits.maxRunMinutes", () => {
    it("parses an explicit per-project maxRunMinutes", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    limits: { maxRunMinutes: 45 },
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                },
            },
        });
        expect(parsed.projects.CG?.limits?.maxRunMinutes).toBe(45);
    });

    it("leaves maxRunMinutes undefined when omitted", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    limits: { inProgress: 2 },
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                },
            },
        });
        expect(parsed.projects.CG?.limits?.maxRunMinutes).toBeUndefined();
    });
});

describe("deadLetter.maxAttempts", () => {
    it("parses a global default deadLetter.maxAttempts", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, deadLetter: { maxAttempts: 5 } },
        });
        expect(parsed.defaults.deadLetter?.maxAttempts).toBe(5);
    });

    it("leaves defaults.deadLetter undefined when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.deadLetter).toBeUndefined();
    });

    it("parses a per-project deadLetter.maxAttempts", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    deadLetter: { maxAttempts: 7 },
                    default_repo: "bin",
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                },
            },
        });
        expect(parsed.projects.CG?.deadLetter?.maxAttempts).toBe(7);
    });
});

describe("qualityGate.commands", () => {
    it("parses a global default qualityGate.commands", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, qualityGate: { commands: ["bun test"] } },
        });
        expect(parsed.defaults.qualityGate?.commands).toEqual(["bun test"]);
    });

    it("leaves defaults.qualityGate undefined when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.qualityGate).toBeUndefined();
    });

    it("parses a per-project qualityGate with multiple commands", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    qualityGate: { commands: ["bun run lint", "bun run typecheck"] },
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                },
            },
        });
        expect(parsed.projects.CG?.qualityGate?.commands).toEqual(["bun run lint", "bun run typecheck"]);
    });
});

describe("routing schema", () => {
    it("parses global defaults.routing", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, routing: { implement: "big", spec: "fast" } },
        });
        expect(parsed.defaults.routing?.implement).toBe("big");
        expect(parsed.defaults.routing?.spec).toBe("fast");
        expect(parsed.defaults.routing?.triage).toBeUndefined();
    });

    it("leaves defaults.routing undefined when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.routing).toBeUndefined();
    });

    it("parses per-project routing", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                    routing: { triage: "triageAgent" },
                },
            },
        });
        expect(parsed.projects.CG?.routing?.triage).toBe("triageAgent");
    });

    it("leaves project routing undefined when omitted", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
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
        });
        expect(parsed.projects.CG?.routing).toBeUndefined();
    });
});

describe("review schema", () => {
    it("parses global defaults.review", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, review: { enabled: true, postToPr: true } },
        });
        expect(parsed.defaults.review?.enabled).toBe(true);
        expect(parsed.defaults.review?.postToPr).toBe(true);
    });

    it("leaves defaults.review undefined when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.review).toBeUndefined();
    });

    it("parses per-project review", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    review: { enabled: true },
                    root: "/root",
                },
            },
        });
        expect(parsed.projects.CG?.review?.enabled).toBe(true);
        expect(parsed.projects.CG?.review?.postToPr).toBeUndefined();
    });

    it("leaves project review undefined when omitted", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
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
        });
        expect(parsed.projects.CG?.review).toBeUndefined();
    });
});

describe("defaults.telemetry", () => {
    it("leaves defaults.telemetry undefined when omitted", () => {
        const parsed = fileSchema.parse(baseFile);
        expect(parsed.defaults.telemetry).toBeUndefined();
    });

    it("parses defaults.telemetry.inComment", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            defaults: { ...baseFile.defaults, telemetry: { inComment: true } },
        });
        expect(parsed.defaults.telemetry?.inComment).toBe(true);
    });

    it("parses per-project telemetry", () => {
        const parsed = fileSchema.parse({
            ...baseFile,
            projects: {
                CG: {
                    default_repo: "bin",
                    module_repo_map: {},
                    name: "My App",
                    plane_project_id: "pid",
                    repos: { bin: "/repo/bin" },
                    root: "/root",
                    telemetry: { inComment: true },
                },
            },
        });
        expect(parsed.projects.CG?.telemetry?.inComment).toBe(true);
    });
});

describe("config.schema.json drift guard", () => {
    it("matches the committed schema generated from fileSchema", () => {
        const generated = zodToJsonSchema(fileSchema, {
            $refStrategy: "none",
            name: "BeflowConfig",
        });
        const committedPath = join(import.meta.dir, "..", "config.schema.json");
        const committed: unknown = JSON.parse(readFileSync(committedPath, "utf8"));
        expect(committed).toEqual(generated);
        if (JSON.stringify(committed) !== JSON.stringify(generated)) {
            throw new Error("config.schema.json is out of date — run `bun run gen:schema`");
        }
    });
});
