import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { configDir } from "../src/config/paths.ts";
import { xdgConfigHome, xdgDataHome, xdgStateHome } from "../src/config/xdg.ts";
import { resolveDecisionsDir } from "../src/core/decisionlog.ts";
import { resolveRunsDir } from "../src/core/runstore.ts";
import { resolveWorktreeDir } from "../src/core/worktree.ts";

type XdgVar = "XDG_CONFIG_HOME" | "XDG_STATE_HOME" | "XDG_DATA_HOME";

const XDG_VARS: XdgVar[] = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"];

interface ResolverCase {
    envVar: XdgVar;
    resolver: () => string;
    fallbackSubpath: string[];
}

const RESOLVERS: ResolverCase[] = [
    { envVar: "XDG_CONFIG_HOME", fallbackSubpath: [".config"], resolver: xdgConfigHome },
    { envVar: "XDG_STATE_HOME", fallbackSubpath: [".local", "state"], resolver: xdgStateHome },
    { envVar: "XDG_DATA_HOME", fallbackSubpath: [".local", "share"], resolver: xdgDataHome },
];

// Save/clear/restore all three XDG vars so each case is hermetic and never leaks
// State into sibling tests. Reflect.deleteProperty avoids a dynamic `delete`.
function hermeticXdgEnv(): void {
    const saved = new Map<XdgVar, string | undefined>();

    beforeEach(() => {
        for (const v of XDG_VARS) {
            saved.set(v, process.env[v]);
            Reflect.deleteProperty(process.env, v);
        }
    });

    afterEach(() => {
        for (const v of XDG_VARS) {
            const prior = saved.get(v);
            if (prior === undefined) {
                Reflect.deleteProperty(process.env, v);
            } else {
                process.env[v] = prior;
            }
        }
    });
}

describe("xdg resolvers", () => {
    hermeticXdgEnv();

    for (const { envVar, resolver, fallbackSubpath } of RESOLVERS) {
        describe(envVar, () => {
            it("honors an absolute env value", () => {
                process.env[envVar] = "/abs/xdg-root";
                expect(resolver()).toBe(join("/abs/xdg-root", "beflow"));
            });

            it("ignores a non-absolute env value and falls back under home", () => {
                process.env[envVar] = "relative/dir";
                expect(resolver()).toBe(join(homedir(), ...fallbackSubpath, "beflow"));
            });

            it("falls back under home when unset", () => {
                expect(resolver()).toBe(join(homedir(), ...fallbackSubpath, "beflow"));
            });
        });
    }
});

describe("consumer default dirs resolve under the correct XDG root", () => {
    hermeticXdgEnv();

    const cases: { name: string; actual: () => string; expected: () => string }[] = [
        { actual: configDir, expected: xdgConfigHome, name: "configDir → config root" },
        { actual: () => resolveRunsDir(), expected: () => join(xdgStateHome(), "runs"), name: "runs → state root" },
        {
            actual: () => resolveDecisionsDir(),
            expected: () => join(xdgStateHome(), "decisions"),
            name: "decisions → state root",
        },
        {
            actual: () => resolveWorktreeDir(),
            expected: () => join(xdgDataHome(), "worktrees"),
            name: "worktrees → data root",
        },
    ];

    for (const { name, actual, expected } of cases) {
        it(name, () => {
            expect(actual()).toBe(expected());
        });
    }
});
