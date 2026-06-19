import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import { ConfigStore } from "../src/config/store.ts";
import type { ConfigWatcher } from "../src/config/store.ts";

function makeConfig(agent: string): Config {
    return {
        agents: { claude: { command: "claude" } },
        agent,
        onManualMove: "yield",
        runMode: "autonomous",
        tracker: "plane",
        trackers: {},
    };
}

const registry: Registry = {
    projects: {},
    workspace: { id: "w", slug: "your-workspace" },
};

function fakeWatcher(): {
    watcher: ConfigWatcher;
    fire: () => void;
    unwatched: () => boolean;
} {
    let onChange: (() => void) | undefined;
    let unwatchedFlag = false;
    const watcher: ConfigWatcher = {
        watch(_filePath, cb) {
            onChange = cb;
            return () => {
                unwatchedFlag = true;
            };
        },
    };
    return {
        fire: () => onChange?.(),
        unwatched: () => unwatchedFlag,
        watcher,
    };
}

describe("ConfigStore", () => {
    it("reload() picks up a valid change and logs", () => {
        const configs = [makeConfig("claude"), makeConfig("omp")];
        let call = 0;
        const logs: string[] = [];
        const store = new ConfigStore("/cfg", {
            loadConfig: () => configs[call++]!,
            loadRegistry: () => registry,
            log: (m) => {
                logs.push(m);
            },
        });
        store.init();
        expect(store.get().config.agent).toBe("claude");

        store.reload();
        expect(store.get().config.agent).toBe("omp");
        expect(logs).toContain("beflow: config reloaded");
    });

    it("reload() on an invalid change keeps the previous snapshot and warns", () => {
        let call = 0;
        const logs: string[] = [];
        const store = new ConfigStore("/cfg", {
            loadConfig: () => {
                call += 1;
                if (call >= 2) {
                    throw new Error("bad config");
                }
                return makeConfig("claude");
            },
            loadRegistry: () => registry,
            log: (m) => {
                logs.push(m);
            },
        });
        store.init();
        expect(store.get().config.agent).toBe("claude");

        expect(() => {
            store.reload();
        }).not.toThrow();
        expect(store.get().config.agent).toBe("claude");
        expect(logs.some((m) => m.includes("config reload failed") && m.includes("keeping previous"))).toBe(true);
    });

    it("start()/stop() reload on change and unwatch on stop", () => {
        const configs = [makeConfig("claude"), makeConfig("omp")];
        let call = 0;
        const { watcher, fire, unwatched } = fakeWatcher();
        const store = new ConfigStore("/cfg", {
            loadConfig: () => configs[Math.min(call++, configs.length - 1)]!,
            loadRegistry: () => registry,
            watcher,
        });
        store.init();
        store.start();
        expect(store.get().config.agent).toBe("claude");

        fire();
        expect(store.get().config.agent).toBe("omp");

        store.stop();
        expect(unwatched()).toBe(true);
    });

    it("init() rethrows when the first load fails (fatal)", () => {
        const store = new ConfigStore("/cfg", {
            loadConfig: () => {
                throw new Error("initial boom");
            },
            loadRegistry: () => registry,
        });
        expect(() => {
            store.init();
        }).toThrow("initial boom");
    });
});
