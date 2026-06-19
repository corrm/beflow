import { describe, expect, it } from "bun:test";

import type { Registry } from "../src/config/schema.ts";
import { beflowBoardTemplate } from "../src/core/template.ts";

const registry: Registry = {
    projects: {
        APP: {
            default_repo: "api",
            module_repo_map: { Backend: "api", Frontend: "web" },
            name: "My App",
            repos: { api: "/path/api", web: "/path/web" },
            root: "/path",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

describe("beflowBoardTemplate", () => {
    it("returns 7 states with correct groups and sequences", () => {
        const tpl = beflowBoardTemplate(registry, "APP", []);
        expect(tpl.states).toHaveLength(7);

        const byName = Object.fromEntries(tpl.states.map((s) => [s.name, s]));
        expect(byName.Backlog).toMatchObject({ group: "backlog", sequence: 15000 });
        expect(byName.Todo).toMatchObject({ group: "unstarted", sequence: 25000 });
        expect(byName["In Progress"]).toMatchObject({ group: "started", sequence: 35000 });
        expect(byName["Needs Input"]).toMatchObject({ group: "started", sequence: 37500 });
        expect(byName["In Review"]).toMatchObject({
            color: "#3B82F6",
            group: "started",
            sequence: 40000,
        });
        expect(byName.Done).toMatchObject({ group: "completed", sequence: 45000 });
        expect(byName.Cancelled).toMatchObject({ group: "cancelled", sequence: 55000 });
    });

    it("returns 4 types", () => {
        const tpl = beflowBoardTemplate(registry, "APP", []);
        expect(tpl.types.map((t) => t.name)).toEqual(["Bug", "Feature", "Chore", "Spike"]);
        expect(tpl.types.every((t) => typeof t.description === "string")).toBe(true);
    });

    it("returns colored functional + runMode picker labels", () => {
        const tpl = beflowBoardTemplate(registry, "APP", []);
        const byName = Object.fromEntries(tpl.labels.map((l) => [l.name, l]));
        expect(byName.blocked).toMatchObject({ color: "#EF4444" });
        expect(byName.failed).toMatchObject({ color: "#B91C1C" });
        expect(byName.quarantined).toMatchObject({ color: "#6B7280" });
        expect(byName.triaged).toMatchObject({ color: "#14B8A6" });
        expect(byName["needs-decision"]).toMatchObject({ color: "#F59E0B" });
        expect(byName["customer-reported"]).toMatchObject({ color: "#8B5CF6" });
        expect(byName["run:autonomous"]).toMatchObject({ color: "#F59E0B" });
        expect(byName["run:supervised"]).toMatchObject({ color: "#3B82F6" });
        expect(byName["jobkind:triage"]).toMatchObject({ color: "#A78BFA" });
        expect(byName["jobkind:spec"]).toMatchObject({ color: "#A78BFA" });
        expect(byName["jobkind:implement"]).toMatchObject({ color: "#A78BFA" });
        expect(tpl.labels.every((l) => typeof l.color === "string")).toBe(true);
    });

    it("appends an agent:<name> label per configured agent", () => {
        const tpl = beflowBoardTemplate(registry, "APP", ["claude", "codex"]);
        const byName = Object.fromEntries(tpl.labels.map((l) => [l.name, l]));
        expect(byName["agent:claude"]).toMatchObject({ color: "#10B981" });
        expect(byName["agent:codex"]).toMatchObject({ color: "#10B981" });
        const names = tpl.labels.map((l) => l.name);
        expect(names).toContain("run:autonomous");
        expect(names).toContain("run:supervised");
        expect(names).toContain("blocked");
    });

    it("derives modules from the registry area names", () => {
        const tpl = beflowBoardTemplate(registry, "APP", []);
        const expected = Object.keys(registry.projects.APP!.module_repo_map);
        expect(tpl.modules.map((m) => m.name)).toEqual(expected);
    });

    it("throws on an unknown project key", () => {
        expect(() => beflowBoardTemplate(registry, "ZZ", [])).toThrow(/unknown project key "ZZ"/);
    });
});
