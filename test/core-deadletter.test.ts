import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { QUARANTINED_LABEL, resolveDeadLetterThreshold, shouldQuarantine } from "../src/core/deadletter.ts";

const config: Config = {
    agents: { claude: { command: "claude" } },
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    runs: { dir: "/runs" },
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

describe("deadletter", () => {
    it("exports the quarantined label constant", () => {
        expect(QUARANTINED_LABEL).toBe("quarantined");
    });

    it("shouldQuarantine is true at or above the threshold", () => {
        expect(shouldQuarantine(3, 3)).toBe(true);
        expect(shouldQuarantine(4, 3)).toBe(true);
    });

    it("shouldQuarantine is false below the threshold", () => {
        expect(shouldQuarantine(0, 3)).toBe(false);
        expect(shouldQuarantine(2, 3)).toBe(false);
    });

    it("resolveDeadLetterThreshold defaults to 3 when nothing is set", () => {
        expect(resolveDeadLetterThreshold(config, registry, "CG")).toBe(3);
    });

    it("resolveDeadLetterThreshold honours the global default", () => {
        const withGlobal: Config = { ...config, deadLetter: { maxAttempts: 5 } };
        expect(resolveDeadLetterThreshold(withGlobal, registry, "CG")).toBe(5);
    });

    it("resolveDeadLetterThreshold lets a project override the global default", () => {
        const withGlobal: Config = { ...config, deadLetter: { maxAttempts: 5 } };
        const withProject: Registry = {
            ...registry,
            projects: { CG: { ...registry.projects.CG!, deadLetter: { maxAttempts: 7 } } },
        };
        expect(resolveDeadLetterThreshold(withGlobal, withProject, "CG")).toBe(7);
    });
});
