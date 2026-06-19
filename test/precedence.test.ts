import { describe, expect, it } from "bun:test";

import type { Project } from "../src/config/schema.ts";
import { cascade, resolve, resolveAgent, resolveRepo, resolveRunMode } from "../src/resolve/precedence.ts";
import type { ResolveInputs } from "../src/resolve/precedence.ts";

const project: Project = {
    default_repo: "api",
    agent: "projAgent",
    runMode: "autonomous",
    module_repo_map: {
        GUI: "api",
        Codegen: "api_codegen",
        Website: "web",
    },
    name: "My App",
    plane_project_id: "p",
    repos: {
        api: "/root/api",
        api_codegen: "/root/api-codegen",
        web: "/root/web",
    },
    root: "/root",
};

function base(overrides: Partial<ResolveInputs> = {}): ResolveInputs {
    return {
        cli: {},
        global: { agent: "globalAgent", runMode: "supervised" },
        issue: { areas: [], state: { group: "started" }, type: "Bug" },
        meta: {},
        project,
        ...overrides,
    };
}

describe("cascade", () => {
    it("returns first defined candidate", () => {
        expect(cascade(undefined, undefined, "a", "b")).toBe("a");
        const noneResult = cascade<string>(undefined, undefined);
        expect(noneResult).toBeUndefined();
    });

    it("treats undefined as skip but not other falsy values", () => {
        expect(cascade(undefined, 0)).toBe(0);
        expect(cascade(undefined, "")).toBe("");
    });
});

describe("resolveAgent cascade order", () => {
    it("CLI beats meta beats project beats global beats built-in", () => {
        expect(resolveAgent(base({ cli: { agent: "cliAgent" }, meta: { agent: "metaAgent" } }), "implement")).toBe(
            "cliAgent",
        );
        expect(resolveAgent(base({ meta: { agent: "metaAgent" } }), "implement")).toBe("metaAgent");
        expect(resolveAgent(base(), "implement")).toBe("projAgent");
    });

    it("falls to global when project has no default", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined };
        expect(resolveAgent(base({ project: p }), "implement")).toBe("globalAgent");
    });

    it("falls to built-in (claude) when nothing else set", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined };
        const inputs = base({ project: p });
        // No global agent configured: the cascade must fall through to the built-in.
        const noGlobal: ResolveInputs = {
            ...inputs,
            global: { agent: undefined, runMode: "supervised" },
        };
        expect(resolveAgent(noGlobal, "implement")).toBe("claude");
    });
});

describe("routing by jobkind", () => {
    it("project.routing selects agent for a matching jobkind", () => {
        const p: Project = { ...project, routing: { implement: "big" } };
        expect(resolveAgent(base({ project: p }), "implement")).toBe("big");
    });

    it("project.routing overrides global.routing for the same jobkind", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined, routing: { spec: "projSpec" } };
        const inputs: ResolveInputs = {
            ...base({ project: p }),
            global: { agent: undefined, routing: { spec: "globalSpec" }, runMode: "supervised" },
        };
        expect(resolveAgent(inputs, "spec")).toBe("projSpec");
    });

    it("global.routing is used when project.routing is absent", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined, routing: undefined };
        const inputs: ResolveInputs = {
            ...base({ project: p }),
            global: { agent: undefined, routing: { triage: "triageAgent" }, runMode: "supervised" },
        };
        expect(resolveAgent(inputs, "triage")).toBe("triageAgent");
    });

    it("cli.agent overrides routing (highest precedence)", () => {
        const p: Project = { ...project, routing: { implement: "big" } };
        const inputs = base({ cli: { agent: "cliOverride" }, project: p });
        expect(resolveAgent(inputs, "implement")).toBe("cliOverride");
    });

    it("meta.agent overrides routing", () => {
        const p: Project = { ...project, routing: { implement: "big" } };
        const inputs = base({ meta: { agent: "metaOverride" }, project: p });
        expect(resolveAgent(inputs, "implement")).toBe("metaOverride");
    });

    it("routing absent falls back to project.agent then global.agent then built-in", () => {
        const p: Project = { ...project, agent: "projAgent", routing: undefined };
        expect(resolveAgent(base({ project: p }), "triage")).toBe("projAgent");

        const noProjectDefaults: Project = { ...project, agent: undefined, runMode: undefined, routing: undefined };
        expect(resolveAgent(base({ project: noProjectDefaults }), "triage")).toBe("globalAgent");

        const noGlobal: ResolveInputs = {
            ...base({ project: noProjectDefaults }),
            global: { agent: undefined, runMode: "supervised" },
        };
        expect(resolveAgent(noGlobal, "triage")).toBe("claude");
    });

    it("routing.implement does not affect spec or triage resolution", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined, routing: { implement: "bigAgent" } };
        const inputs: ResolveInputs = {
            ...base({ project: p }),
            global: { agent: "globalAgent", runMode: "supervised" },
        };
        expect(resolveAgent(inputs, "spec")).toBe("globalAgent");
        expect(resolveAgent(inputs, "triage")).toBe("globalAgent");
    });
});

describe("resolveRunMode cascade order", () => {
    it("CLI beats meta beats project beats global", () => {
        expect(resolveRunMode(base({ cli: { runMode: "supervised" }, meta: { runMode: "autonomous" } }))).toBe(
            "supervised",
        );
        expect(resolveRunMode(base({ meta: { runMode: "supervised" } }))).toBe("supervised");
        expect(resolveRunMode(base())).toBe("autonomous"); // Project default
    });

    it("built-in fallback is supervised", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined };
        const inputs = base({ project: p });
        // No global runMode configured: the cascade must fall through to the built-in.
        const noGlobal: ResolveInputs = {
            ...inputs,
            global: { agent: "g", runMode: undefined },
        };
        expect(resolveRunMode(noGlobal)).toBe("supervised");
    });
});

describe("resolveRepo", () => {
    it("CLI repo wins and resolves repoPath", () => {
        const r = resolveRepo(base({ cli: { repo: "web" } }));
        expect(r).toEqual({
            repo: "web",
            repoPath: "/root/web",
        });
    });

    it("meta repo beats area-derived and default", () => {
        const r = resolveRepo(
            base({
                issue: { areas: ["GUI"], state: { group: "started" }, type: "Bug" },
                meta: { repo: "web" },
            }),
        );
        expect(r.repo).toBe("web");
    });

    it("area-derived via module_repo_map[areas[0]] (primary area only)", () => {
        const r = resolveRepo(
            base({
                issue: {
                    areas: ["Website", "GUI"],
                    state: { group: "started" },
                    type: "Bug",
                },
            }),
        );
        expect(r.repo).toBe("web");
    });

    it("no areas / unmapped area falls to project default_repo", () => {
        expect(resolveRepo(base({ issue: { areas: [], state: { group: "started" }, type: "Bug" } })).repo).toBe("api");
        expect(
            resolveRepo(
                base({
                    issue: {
                        areas: ["Unmapped"],
                        state: { group: "started" },
                        type: "Bug",
                    },
                }),
            ).repo,
        ).toBe("api");
    });

    it("throws a clear error when resolved repo key not in project.repos", () => {
        expect(() => resolveRepo(base({ cli: { repo: "ghost" } }))).toThrow(/resolved repo "ghost" is not present/);
    });
});

describe("resolve (top-level)", () => {
    it("composes every field through its cascade", () => {
        const out = resolve(
            base({
                cli: { agent: "cliAgent" },
                issue: { areas: ["Website"], state: { group: "started" }, type: "Bug" },
                meta: { jobKind: "triage", runMode: "autonomous" },
            }),
        );
        expect(out).toEqual({
            agent: "cliAgent",
            jobKind: "triage",
            repo: "web",
            repoPath: "/root/web",
            runMode: "autonomous",
        });
    });

    it("uses built-ins and auto-detect when nothing overrides", () => {
        const p: Project = { ...project, agent: undefined, runMode: undefined };
        const out = resolve(
            base({
                global: { agent: "globalAgent", runMode: "supervised" },
                issue: { areas: [], state: { group: "backlog" }, type: "Feature" },
                project: p,
            }),
        );
        expect(out.agent).toBe("globalAgent");
        expect(out.runMode).toBe("supervised");
        expect(out.repo).toBe("api");
        expect(out.jobKind).toBe("spec");
    });
});
