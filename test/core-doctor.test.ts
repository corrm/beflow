import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { doctor } from "../src/core/doctor.ts";
import type { DoctorCheck, DoctorDeps } from "../src/core/doctor.ts";

const config: Config = {
    agents: {},
    defaults: { agent: "claude", onManualMove: "yield", runMode: "supervised" },
    tracker: "plane",
    trackers: {
        plane: {
            apiKeyEnv: "PLANE_API_KEY",
            baseUrl: "https://api.plane.so",
            workspaceSlug: "your-workspace",
        },
    },
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

function baseDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
        env: { PLANE_API_KEY: "secret" },
        fileExists: () => true,
        loadConfig: () => config,
        loadRegistry: () => registry,
        onPath: () => true,
        ...overrides,
    };
}

function find(checks: DoctorCheck[], name: string): DoctorCheck {
    const c = checks.find((x) => x.name === name);
    if (c === undefined) {
        throw new Error(`no check named "${name}"`);
    }
    return c;
}

describe("doctor", () => {
    it("all checks pass with healthy deps", async () => {
        const checks = await doctor(baseDeps());
        expect(checks.every((c) => c.level === "pass")).toBe(true);
        expect(find(checks, "config").detail).toContain("plane");
    });

    it("fails when config load throws, capturing the error detail", async () => {
        const checks = await doctor(
            baseDeps({
                loadConfig: () => {
                    throw new Error("config boom");
                },
            }),
        );
        expect(find(checks, "config").level).toBe("fail");
        expect(find(checks, "config").detail).toContain("config boom");
        // Dependent checks are skipped, not crashed
        expect(find(checks, "tracker config").level).toBe("fail");
        expect(find(checks, "API key").level).toBe("fail");
    });

    it("fails when the active tracker config is missing", async () => {
        const noTracker: Config = { ...config, trackers: {} };
        const checks = await doctor(baseDeps({ loadConfig: () => noTracker }));
        expect(find(checks, "tracker config").level).toBe("fail");
    });

    it("fails when the registry has no projects", async () => {
        const empty: Registry = { ...registry, projects: {} };
        const checks = await doctor(baseDeps({ loadRegistry: () => empty }));
        expect(find(checks, "projects").level).toBe("fail");
        expect(find(checks, "repos on disk").level).toBe("fail");
    });

    it("fails with a mint hint when the API key env is unset", async () => {
        const checks = await doctor(baseDeps({ env: {} }));
        const apiKey = find(checks, "API key");
        expect(apiKey.level).toBe("fail");
        expect(apiKey.detail).toContain("API token");
        expect(apiKey.detail).toContain("PLANE_API_KEY");
    });

    it("fails when a repo path is missing on disk", async () => {
        const checks = await doctor(baseDeps({ fileExists: (p) => p !== "/repo/bin" }));
        const repos = find(checks, "repos on disk");
        expect(repos.level).toBe("fail");
        expect(repos.detail).toContain("/repo/bin");
    });

    it("checks the default bunx launcher and reports the resolved command", async () => {
        const checks = await doctor(baseDeps({ onPath: (c) => c === "bunx" }));
        const acpx = find(checks, "acpx");
        expect(acpx.level).toBe("pass");
        expect(acpx.detail).toContain("bunx acpx");
    });

    it("fails when the default bunx launcher is not on PATH", async () => {
        const checks = await doctor(baseDeps({ onPath: (c) => c !== "bunx" }));
        const acpx = find(checks, "acpx");
        expect(acpx.level).toBe("fail");
        expect(acpx.detail).toContain("bunx acpx");
        expect(acpx.detail).toContain("bun add -g acpx");
    });

    it("checks the configured tools.acpx launcher when set", async () => {
        const cfg: Config = { ...config, tools: { acpx: ["acpx"] } };
        const checks = await doctor(baseDeps({ loadConfig: () => cfg, onPath: (c) => c === "acpx" }));
        const acpx = find(checks, "acpx");
        expect(acpx.level).toBe("pass");
        expect(acpx.detail).toContain("found on PATH (acpx)");
    });

    it("warns (not fails) when gh is not on PATH", async () => {
        const checks = await doctor(baseDeps({ onPath: (c) => c !== "gh" }));
        expect(find(checks, "gh").level).toBe("warn");
    });

    it("passes the live ping with its detail when supplied", async () => {
        const checks = await doctor(baseDeps({ ping: async () => "reached plane; 3 Todo item(s) in CG" }));
        const ping = find(checks, "live ping");
        expect(ping.level).toBe("pass");
        expect(ping.detail).toContain("3 Todo");
    });

    it("fails the live ping when it rejects", async () => {
        const checks = await doctor(
            baseDeps({
                ping: async () => {
                    throw new Error("401 unauthorized");
                },
            }),
        );
        const ping = find(checks, "live ping");
        expect(ping.level).toBe("fail");
        expect(ping.detail).toContain("401");
    });

    it("does not call ping when an earlier check failed", async () => {
        let called = false;
        const checks = await doctor(
            baseDeps({
                env: {},
                ping: async () => {
                    called = true;
                    return "should not run";
                },
            }),
        );
        expect(called).toBe(false);
        expect(find(checks, "live ping").level).toBe("fail");
        expect(find(checks, "live ping").detail).toContain("earlier check");
    });

    it("omits the live ping check entirely when no ping is provided", async () => {
        const checks = await doctor(baseDeps());
        expect(checks.some((c) => c.name === "live ping")).toBe(false);
    });

    it("appends boardChecks results when prerequisites pass", async () => {
        const checks = await doctor(
            baseDeps({
                boardChecks: async () => [{ detail: "matches template", level: "pass", name: "board:CG" }],
            }),
        );
        const board = find(checks, "board:CG");
        expect(board.level).toBe("pass");
        expect(board.detail).toContain("matches template");
    });

    it("skips boardChecks with a single fail check when a prereq fails", async () => {
        let called = false;
        const checks = await doctor(
            baseDeps({
                boardChecks: async () => {
                    called = true;
                    return [];
                },
                env: {},
            }),
        );
        expect(called).toBe(false);
        const board = find(checks, "board drift");
        expect(board.level).toBe("fail");
        expect(board.detail).toContain("earlier check");
    });

    it("fails the board drift check when boardChecks throws", async () => {
        const checks = await doctor(
            baseDeps({
                boardChecks: async () => {
                    throw new Error("inspect blew up");
                },
            }),
        );
        const board = find(checks, "board drift");
        expect(board.level).toBe("fail");
        expect(board.detail).toContain("inspect blew up");
    });

    it("omits the board drift check when no boardChecks is provided", async () => {
        const checks = await doctor(baseDeps());
        expect(checks.some((c) => c.name === "board drift")).toBe(false);
    });
});
