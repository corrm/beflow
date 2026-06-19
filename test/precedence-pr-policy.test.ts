import { describe, expect, it } from "bun:test";

import type { Config, PolicyConfig, Registry } from "../src/config/schema.ts";
import { resolvePolicy, resolvePr } from "../src/resolve/precedence.ts";

const config: Config = {
    agents: {},
    defaults: { agent: "claude", onManualMove: "yield", runMode: "autonomous" },
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

describe("resolvePr", () => {
    it("applies built-in defaults when neither layer sets pr", () => {
        expect(resolvePr(config, registryWith(), "CG")).toEqual({ owner: "agent", baseBranch: "auto" });
    });

    it("falls back to the global default pr block", () => {
        const cfg: Config = {
            ...config,
            defaults: { ...config.defaults, pr: { owner: "beflow", baseBranch: "main" } },
        };
        expect(resolvePr(cfg, registryWith(), "CG")).toEqual({ owner: "beflow", baseBranch: "main" });
    });

    it("project pr replaces the global default", () => {
        const cfg: Config = {
            ...config,
            defaults: { ...config.defaults, pr: { owner: "agent", baseBranch: "develop" } },
        };
        const reg = registryWith({ pr: { owner: "beflow", baseBranch: "main" } });
        expect(resolvePr(cfg, reg, "CG")).toEqual({ owner: "beflow", baseBranch: "main" });
    });

    it("fills missing fields from built-in defaults on a partial block", () => {
        const reg = registryWith({ pr: { owner: "beflow" } });
        expect(resolvePr(config, reg, "CG")).toEqual({ owner: "beflow", baseBranch: "auto" });

        const cfg: Config = { ...config, defaults: { ...config.defaults, pr: { baseBranch: "main" } } };
        expect(resolvePr(cfg, registryWith(), "CG")).toEqual({ owner: "agent", baseBranch: "main" });
    });

    it("applies defaults for an unknown project key", () => {
        expect(resolvePr(config, registryWith(), "ZZ")).toEqual({ owner: "agent", baseBranch: "auto" });
    });
});

describe("resolvePolicy", () => {
    it("defaults to evaluator off when no policy is set anywhere", () => {
        expect(resolvePolicy(config, registryWith(), "CG")).toEqual({ evaluator: "off", onBlock: "comment" });
    });

    it("falls back to the top-level global policy", () => {
        const policy: PolicyConfig = { evaluator: "command", command: ["./gate.sh"], onBlock: "comment" };
        const cfg: Config = { ...config, policy };
        expect(resolvePolicy(cfg, registryWith(), "CG")).toEqual({
            evaluator: "command",
            command: ["./gate.sh"],
            rules: undefined,
            onBlock: "comment",
        });
    });

    it("project policy replaces the global policy wholesale (not merged)", () => {
        const cfg: Config = {
            ...config,
            policy: { evaluator: "command", command: ["./global.sh"], onBlock: "comment" },
        };
        const projectPolicy: PolicyConfig = {
            evaluator: "globs",
            rules: [{ paths: ["infra/**"], decision: "block" }],
        };
        const reg = registryWith({ policy: projectPolicy });
        // The global `command` must NOT leak through: replacement is wholesale.
        expect(resolvePolicy(cfg, reg, "CG")).toEqual({
            evaluator: "globs",
            command: undefined,
            rules: [{ paths: ["infra/**"], decision: "block" }],
            onBlock: "comment",
        });
    });

    it("round-trips globs rules through the type", () => {
        const policy: PolicyConfig = {
            evaluator: "globs",
            rules: [
                { paths: ["**/*.tf"], decision: "require_approval" },
                { paths: [".github/**"], agent: "claude", decision: "block" },
                { decision: "allow" },
            ],
            onBlock: "comment",
        };
        const cfg: Config = { ...config, policy };
        const resolved = resolvePolicy(cfg, registryWith(), "CG");
        expect(resolved.rules).toEqual([
            { paths: ["**/*.tf"], decision: "require_approval" },
            { paths: [".github/**"], agent: "claude", decision: "block" },
            { decision: "allow" },
        ]);
    });

    it("fills missing onBlock from the built-in default", () => {
        const reg = registryWith({ policy: { evaluator: "globs" } });
        expect(resolvePolicy(config, reg, "CG")).toEqual({
            evaluator: "globs",
            command: undefined,
            rules: undefined,
            onBlock: "comment",
        });
    });

    it("applies defaults for an unknown project key", () => {
        expect(resolvePolicy(config, registryWith(), "ZZ")).toEqual({ evaluator: "off", onBlock: "comment" });
    });
});
