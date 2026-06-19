import { describe, expect, it } from "bun:test";

import type { Project } from "../src/config/schema.ts";
import type { StateGroup } from "../src/model/types.ts";
import { autoDetectJobKind } from "../src/resolve/jobkind.ts";
import { resolveJobKind } from "../src/resolve/precedence.ts";
import type { ResolveInputs } from "../src/resolve/precedence.ts";

const project: Project = {
    default_repo: "r",
    defaults: undefined,
    module_repo_map: {},
    name: "X",
    plane_project_id: "p",
    repos: { r: "/r" },
    root: "/r",
};

function inputs(
    type: string | undefined,
    group: StateGroup,
    cli: ResolveInputs["cli"] = {},
    meta: ResolveInputs["meta"] = {},
): ResolveInputs {
    return {
        cli,
        global: { agent: "claude", runMode: "supervised" },
        issue: { areas: [], state: { group }, type },
        meta,
        project,
    };
}

describe("autoDetectJobKind", () => {
    it("Spike -> triage regardless of state", () => {
        expect(autoDetectJobKind("Spike", "started")).toBe("triage");
        expect(autoDetectJobKind("Spike", "backlog")).toBe("triage");
    });

    it("backlog (non-Spike) -> spec", () => {
        expect(autoDetectJobKind("Feature", "backlog")).toBe("spec");
        expect(autoDetectJobKind(undefined, "backlog")).toBe("spec");
    });

    it("started / unstarted -> implement", () => {
        expect(autoDetectJobKind("Bug", "started")).toBe("implement");
        expect(autoDetectJobKind("Feature", "unstarted")).toBe("implement");
    });
});

describe("resolveJobKind override", () => {
    it("CLI overrides auto-detect", () => {
        expect(resolveJobKind(inputs("Spike", "started", { jobKind: "implement" }))).toBe("implement");
    });

    it("metadata overrides auto-detect", () => {
        expect(resolveJobKind(inputs("Feature", "backlog", {}, { jobKind: "triage" }))).toBe("triage");
    });

    it("CLI beats metadata", () => {
        expect(resolveJobKind(inputs("Bug", "started", { jobKind: "spec" }, { jobKind: "triage" }))).toBe("spec");
    });

    it("falls back to auto-detect when no override", () => {
        expect(resolveJobKind(inputs("Feature", "started"))).toBe("implement");
    });
});
