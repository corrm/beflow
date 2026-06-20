import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import {
    pinBaselineTests,
    resolveBaselineTestGlobs,
    resolveQualityGate,
    runQualityGate,
} from "../src/core/qualitygate.ts";
import type { GateExec } from "../src/core/qualitygate.ts";
import type { Exec, ExecResult } from "../src/core/worktree.ts";

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

describe("resolveBaselineTestGlobs", () => {
    it("returns [] when neither layer sets baselineTestGlobs", () => {
        expect(resolveBaselineTestGlobs(config, registryWith(), "CG")).toEqual([]);
    });

    it("falls back to the global default globs", () => {
        const cfg: Config = { ...config, qualityGate: { baselineTestGlobs: ["**/*.test.ts"] } };
        expect(resolveBaselineTestGlobs(cfg, registryWith(), "CG")).toEqual(["**/*.test.ts"]);
    });

    it("project globs override the global default", () => {
        const cfg: Config = { ...config, qualityGate: { baselineTestGlobs: ["global"] } };
        const reg = registryWith({ qualityGate: { baselineTestGlobs: ["project"] } });
        expect(resolveBaselineTestGlobs(cfg, reg, "CG")).toEqual(["project"]);
    });
});

describe("pinBaselineTests", () => {
    /**
     * Fake git: `cat-file -e <ref>:<path>` resolves against `existsAt` (a set of
     * `<ref>:<path>` keys present at that ref), exiting non-zero when absent — the
     * expected "absent" answer, never thrown. Every other git call records and
     * succeeds. Defaults to all paths present at every ref.
     */
    function recordingExec(existsAt?: Set<string>): { exec: Exec; calls: string[][] } {
        const calls: string[][] = [];
        const exec: Exec = async (cmd, args): Promise<ExecResult> => {
            if (cmd === "git" && args.includes("cat-file")) {
                const spec = args[args.length - 1] ?? "";
                const present = existsAt === undefined || existsAt.has(spec);
                return { code: present ? 0 : 1, stderr: present ? "" : "not found", stdout: "" };
            }
            calls.push([cmd, ...args]);
            return { code: 0, stderr: "", stdout: "" };
        };
        return { calls, exec };
    }

    it("checks out the base version of changed files matching a glob, then restores HEAD", async () => {
        const { exec, calls } = recordingExec();
        const restore = await pinBaselineTests(
            "/wt",
            "main",
            ["src/app.ts", "src/app.test.ts"],
            ["**/*.test.ts"],
            exec,
        );
        // Only the test file is pinned to the base; src/app.ts (implementation) is not.
        expect(calls).toEqual([["git", "-C", "/wt", "checkout", "main", "--", "src/app.test.ts"]]);
        await restore();
        expect(calls[1]).toEqual(["git", "-C", "/wt", "checkout", "HEAD", "--", "src/app.test.ts"]);
    });

    it("does NOT pin an ADDED test file (absent in base) — only pre-existing matches", async () => {
        // src/added.test.ts exists only in HEAD; src/app.test.ts exists in both.
        const existsAt = new Set(["main:src/app.test.ts", "HEAD:src/app.test.ts", "HEAD:src/added.test.ts"]);
        const { exec, calls } = recordingExec(existsAt);
        const restore = await pinBaselineTests(
            "/wt",
            "main",
            ["src/app.test.ts", "src/added.test.ts"],
            ["**/*.test.ts"],
            exec,
        );
        const checkoutBase = calls.find((c) => c.includes("checkout") && c.includes("main"));
        expect(checkoutBase).toEqual(["git", "-C", "/wt", "checkout", "main", "--", "src/app.test.ts"]);
        expect(checkoutBase).not.toContain("src/added.test.ts");
        await restore();
        const restored = calls.find((c) => c.includes("checkout") && c.includes("HEAD"));
        expect(restored).toEqual(["git", "-C", "/wt", "checkout", "HEAD", "--", "src/app.test.ts"]);
    });

    it("restores a DELETED-in-HEAD test by removing it (no throw, no leaked baseline)", async () => {
        // src/app.test.ts exists in base but was deleted by the agent (absent in HEAD).
        const existsAt = new Set(["main:src/app.test.ts"]);
        const { exec, calls } = recordingExec(existsAt);
        const restore = await pinBaselineTests("/wt", "main", ["src/app.test.ts"], ["**/*.test.ts"], exec);
        // The base version is laid down so the gate grades against it.
        expect(calls).toEqual([["git", "-C", "/wt", "checkout", "main", "--", "src/app.test.ts"]]);
        await restore();
        // Restore matches HEAD by removing the file again — never `checkout HEAD` (which would throw).
        expect(calls.some((c) => c.includes("checkout") && c.includes("HEAD"))).toBe(false);
        expect(calls).toContainEqual(["git", "-C", "/wt", "rm", "-f", "--", "src/app.test.ts"]);
    });

    it("is a no-op (no checkout, no-op restore) when no changed file matches", async () => {
        const { exec, calls } = recordingExec();
        const restore = await pinBaselineTests("/wt", "main", ["src/app.ts"], ["**/*.test.ts"], exec);
        await restore();
        expect(calls).toEqual([]);
    });

    it("throws when the baseline checkout fails (no silent self-grade)", async () => {
        const exec: Exec = async (_cmd, args) => {
            if (args.includes("cat-file")) {
                return { code: 0, stderr: "", stdout: "" };
            }
            return { code: 1, stderr: "no such ref", stdout: "" };
        };
        expect(pinBaselineTests("/wt", "main", ["src/app.test.ts"], ["**/*.test.ts"], exec)).rejects.toThrow(
            /git .* checkout .* failed/,
        );
    });
});
