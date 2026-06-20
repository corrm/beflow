import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { createTracker } from "../src/trackers/factory.ts";
import { LinearTracker } from "../src/trackers/linear/adapter.ts";
import { PlaneTracker } from "../src/trackers/plane/adapter.ts";

const registry: Registry = {
    projects: {
        CG: {
            default_repo: "app",
            module_repo_map: {},
            name: "My App",
            plane_project_id: "pid",
            repos: { app: "/x/app" },
            root: "/x",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

function config(overrides: Partial<Config>): Config {
    return {
        agents: {},
        agent: "claude",
        onManualMove: "yield",
        runMode: "supervised",
        tracker: "plane",
        trackers: {
            linear: { apiKeyEnv: "LINEAR_API_KEY" },
            plane: {
                apiKeyEnv: "PLANE_API_KEY",
                baseUrl: "https://api.plane.so",
                workspaceSlug: "your-workspace",
            },
        },
        ...overrides,
    };
}

describe("createTracker", () => {
    it('returns a PlaneTracker for tracker:"plane" and reads PLANE_API_KEY', () => {
        const t = createTracker(config({ tracker: "plane" }), registry, {
            PLANE_API_KEY: "abc",
        });
        expect(t).toBeInstanceOf(PlaneTracker);
    });

    it('returns a LinearTracker for tracker:"linear" and reads LINEAR_API_KEY', () => {
        const t = createTracker(config({ tracker: "linear" }), registry, {
            LINEAR_API_KEY: "xyz",
        });
        expect(t).toBeInstanceOf(LinearTracker);
    });

    it("plane factory throws when PLANE_API_KEY is unset", () => {
        expect(() => createTracker(config({ tracker: "plane" }), registry, {})).toThrow(/PLANE_API_KEY.* is unset/);
    });

    it("linear factory throws when LINEAR_API_KEY is unset", () => {
        expect(() => createTracker(config({ tracker: "linear" }), registry, {})).toThrow(/LINEAR_API_KEY.* is unset/);
    });

    it("throws on an unknown tracker", () => {
        const bad = config({});
        (bad as { tracker: string }).tracker = "jira";
        expect(() => createTracker(bad, registry, {})).toThrow(/unknown tracker "jira"/);
    });
});
