import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { isThinIssue, resolveMinBodyChars, visibleBodyLength } from "../src/core/inputquality.ts";

const config: Config = {
    agents: {},
    defaults: { agent: "claude", onManualMove: "yield", runMode: "autonomous" },
    tracker: "plane",
    trackers: {},
};

function registryWith(over?: { global?: number; project?: number }): { config: Config; registry: Registry } {
    const cfg: Config =
        over?.global === undefined
            ? config
            : { ...config, defaults: { ...config.defaults, inputQuality: { minBodyChars: over.global } } };
    const registry: Registry = {
        projects: {
            CG: {
                default_repo: "bin",
                module_repo_map: {},
                name: "My App",
                plane_project_id: "pid",
                repos: { bin: "/repo/bin" },
                root: "/root",
                ...(over?.project !== undefined ? { inputQuality: { minBodyChars: over.project } } : {}),
            },
        },
        workspace: { id: "w", slug: "your-workspace" },
    };
    return { config: cfg, registry };
}

describe("visibleBodyLength", () => {
    it("strips HTML tags", () => {
        expect(visibleBodyLength("<p>hello</p>")).toBe(5);
    });

    it("decodes the common entities", () => {
        expect(visibleBodyLength("a&nbsp;b")).toBe(3);
        expect(visibleBodyLength("&amp;&lt;&gt;")).toBe(3);
    });

    it("collapses whitespace runs and trims", () => {
        expect(visibleBodyLength("  a \n\t  b  ")).toBe(3);
    });

    it("counts an empty / markup-only body as zero", () => {
        expect(visibleBodyLength("")).toBe(0);
        expect(visibleBodyLength("<p></p>\n<br/>")).toBe(0);
    });
});

describe("isThinIssue", () => {
    it("is true when the visible length is below the threshold", () => {
        expect(isThinIssue("<p>tiny</p>", 20)).toBe(true);
    });

    it("is false when the visible length meets the threshold", () => {
        expect(isThinIssue("<p>this is a long enough description</p>", 20)).toBe(false);
    });

    it("is never thin when minBodyChars is 0 (gate off)", () => {
        expect(isThinIssue("", 0)).toBe(false);
        expect(isThinIssue("<p></p>", 0)).toBe(false);
    });
});

describe("resolveMinBodyChars", () => {
    it("returns 0 when neither project nor global is set", () => {
        const { config: cfg, registry } = registryWith();
        expect(resolveMinBodyChars(cfg, registry, "CG")).toBe(0);
    });

    it("uses the global default when no per-project override exists", () => {
        const { config: cfg, registry } = registryWith({ global: 30 });
        expect(resolveMinBodyChars(cfg, registry, "CG")).toBe(30);
    });

    it("prefers the per-project override over the global default", () => {
        const { config: cfg, registry } = registryWith({ global: 30, project: 80 });
        expect(resolveMinBodyChars(cfg, registry, "CG")).toBe(80);
    });

    it("returns 0 for an unknown project key with no global", () => {
        const { config: cfg, registry } = registryWith();
        expect(resolveMinBodyChars(cfg, registry, "ZZ")).toBe(0);
    });
});
