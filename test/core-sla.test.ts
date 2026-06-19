import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import type { RunRecord } from "../src/core/runstore.ts";
import { ageMinutes, formatAge, resolveSla, shouldRemind } from "../src/core/sla.ts";

const baseConfig: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    runs: { dir: "/runs" },
    tracker: "plane",
    trackers: {},
};

const baseRegistry: Registry = {
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

function record(over: Partial<RunRecord> = {}): RunRecord {
    return {
        agent: "claude",
        cwd: "/repo/bin",
        jobKind: "implement",
        key: "CG-1",
        runMode: "autonomous",
        sessionName: "CG-1",
        status: "needs_input",
        updatedAt: "2026-06-14T00:00:00.000Z",
        ...over,
    };
}

describe("resolveSla", () => {
    it("returns an empty object when nothing is configured", () => {
        expect(resolveSla(baseConfig, baseRegistry, "CG")).toEqual({});
    });

    it("uses the global defaults when no project override exists", () => {
        const config: Config = {
            ...baseConfig,
            sla: { inReviewMinutes: 120, needsInputMinutes: 60 },
        };
        expect(resolveSla(config, baseRegistry, "CG")).toEqual({ inReviewMinutes: 120, needsInputMinutes: 60 });
    });

    it("prefers the per-project override over the global default", () => {
        const config: Config = {
            ...baseConfig,
            sla: { inReviewMinutes: 120, needsInputMinutes: 60 },
        };
        const registry: Registry = {
            ...baseRegistry,
            projects: {
                CG: { ...baseRegistry.projects.CG!, sla: { needsInputMinutes: 30 } },
            },
        };
        // Project overrides needsInputMinutes; inReviewMinutes falls back to the global.
        expect(resolveSla(config, registry, "CG")).toEqual({ inReviewMinutes: 120, needsInputMinutes: 30 });
    });

    it("omits keys that are undefined in both project and global", () => {
        const registry: Registry = {
            ...baseRegistry,
            projects: {
                CG: { ...baseRegistry.projects.CG!, sla: { inReviewMinutes: 90 } },
            },
        };
        const out = resolveSla(baseConfig, registry, "CG");
        expect(out).toEqual({ inReviewMinutes: 90 });
        expect("needsInputMinutes" in out).toBe(false);
    });
});

describe("ageMinutes", () => {
    it("computes the gap in minutes", () => {
        expect(ageMinutes("2026-06-14T01:00:00.000Z", "2026-06-14T00:00:00.000Z")).toBe(60);
        expect(ageMinutes("2026-06-14T00:30:00.000Z", "2026-06-14T00:00:00.000Z")).toBe(30);
    });
});

describe("formatAge", () => {
    it("renders minutes below an hour", () => {
        expect(formatAge(0)).toBe("0m");
        expect(formatAge(59)).toBe("59m");
    });

    it("renders hours from one hour up to a day", () => {
        expect(formatAge(60)).toBe("1h");
        expect(formatAge(90)).toBe("2h");
        expect(formatAge(1439)).toBe("24h");
    });

    it("renders days at and beyond one day", () => {
        expect(formatAge(1440)).toBe("1d");
        expect(formatAge(2880)).toBe("2d");
    });
});

describe("shouldRemind", () => {
    const now = "2026-06-14T02:00:00.000Z";

    it("is false below the threshold", () => {
        const rec = record({ updatedAt: "2026-06-14T01:30:00.000Z" });
        expect(shouldRemind(now, rec, 60)).toBe(false);
    });

    it("is true at the threshold when never escalated", () => {
        const rec = record({ updatedAt: "2026-06-14T01:00:00.000Z" });
        expect(shouldRemind(now, rec, 60)).toBe(true);
    });

    it("is false when escalated more recently than the threshold", () => {
        const rec = record({ escalatedAt: "2026-06-14T01:30:00.000Z", updatedAt: "2026-06-14T00:00:00.000Z" });
        expect(shouldRemind(now, rec, 60)).toBe(false);
    });

    it("is true when the last escalation is older than the threshold", () => {
        const rec = record({ escalatedAt: "2026-06-14T00:30:00.000Z", updatedAt: "2026-06-14T00:00:00.000Z" });
        expect(shouldRemind(now, rec, 60)).toBe(true);
    });
});
