import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { resolveQualityGate, runQualityGate } from "../src/core/qualitygate.ts";
import type { GateExec } from "../src/core/qualitygate.ts";

const config: Config = {
    agents: {},
    agent: "claude",
    onManualMove: "yield",
    runMode: "autonomous",
    tracker: "plane",
    trackers: {},
};

function registryWith(over: Partial<Registry["projects"]["CG"]> = {}): Registry {
    return {
        projects: {
            CG: {
                default_repo: "bin",
                module_repo_map: {},
                name: "My App",
                plane_project_id: "pid",
                repos: { bin: "/repo/bin" },
                root: "/root",
                ...over,
            },
        },
        workspace: { id: "w", slug: "your-workspace" },
    };
}

describe("resolveQualityGate", () => {
    it("returns [] when neither layer sets commands (gate off)", () => {
        expect(resolveQualityGate(config, registryWith(), "CG")).toEqual([]);
    });

    it("falls back to the global default commands", () => {
        const cfg: Config = { ...config, qualityGate: { commands: ["bun test"] } };
        expect(resolveQualityGate(cfg, registryWith(), "CG")).toEqual(["bun test"]);
    });

    it("project commands override the global default", () => {
        const cfg: Config = { ...config, qualityGate: { commands: ["global"] } };
        const reg = registryWith({ qualityGate: { commands: ["project"] } });
        expect(resolveQualityGate(cfg, reg, "CG")).toEqual(["project"]);
    });

    it("returns [] for an unknown project key", () => {
        expect(resolveQualityGate(config, registryWith(), "ZZ")).toEqual([]);
    });
});

describe("runQualityGate", () => {
    function recordingExec(codes: number[]): { exec: GateExec; ran: string[] } {
        const ran: string[] = [];
        let i = 0;
        const exec: GateExec = async (command, _cwd) => {
            ran.push(command);
            const exitCode = codes[i] ?? 0;
            i += 1;
            return { exitCode, output: `out:${command}` };
        };
        return { exec, ran };
    }

    it("passes when every command exits 0 and captures combined output", async () => {
        const { exec, ran } = recordingExec([0, 0]);
        const res = await runQualityGate(["a", "b"], "/wt", exec);
        expect(res.passed).toBe(true);
        expect(ran).toEqual(["a", "b"]);
        expect(res.output).toContain("out:a");
        expect(res.output).toContain("out:b");
    });

    it("stops at the FIRST non-zero exit and reports red", async () => {
        const { exec, ran } = recordingExec([1, 0]);
        const res = await runQualityGate(["a", "b"], "/wt", exec);
        expect(res.passed).toBe(false);
        // The second command is never run.
        expect(ran).toEqual(["a"]);
        expect(res.output).toContain("out:a");
        expect(res.output).not.toContain("out:b");
    });

    it("passes the cwd through to the exec", async () => {
        let seenCwd = "";
        const exec: GateExec = async (_command, cwd) => {
            seenCwd = cwd;
            return { exitCode: 0, output: "" };
        };
        await runQualityGate(["a"], "/the/worktree", exec);
        expect(seenCwd).toBe("/the/worktree");
    });
});
