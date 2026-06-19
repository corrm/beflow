import { watch as fsWatch } from "node:fs";
import { join } from "node:path";

import { loadConfig, loadRegistry } from "./load.ts";
import type { Config, Registry } from "./schema.ts";

export interface ConfigSnapshot {
    config: Config;
    registry: Registry;
}

// Injectable file-watcher seam so ConfigStore is testable without real fs.
export interface ConfigWatcher {
    // Returns an unwatch fn that stops the watcher.
    watch(filePath: string, onChange: () => void): () => void;
}

const WATCH_DEBOUNCE_MS = 100;

export const nodeConfigWatcher: ConfigWatcher = {
    watch(filePath, onChange) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watcher = fsWatch(filePath, () => {
            // Editors fire multiple events per save; debounce to a single reload.
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
        });
        return () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            watcher.close();
        };
    },
};

export interface ConfigStoreOpts {
    log?: (m: string) => void;
    loadConfig?: (dir: string) => Config;
    loadRegistry?: (dir: string) => Registry;
    watcher?: ConfigWatcher;
}

export class ConfigStore {
    private readonly dir: string;
    private readonly log: (m: string) => void;
    private readonly loadConfig: (dir: string) => Config;
    private readonly loadRegistry: (dir: string) => Registry;
    private readonly watcher: ConfigWatcher;
    private snapshot: ConfigSnapshot | undefined;
    private unwatch: (() => void) | undefined;

    public constructor(dir: string, opts: ConfigStoreOpts = {}) {
        this.dir = dir;
        this.log =
            opts.log ??
            ((): void => {
                /* no-op: logging disabled */
            });
        this.loadConfig = opts.loadConfig ?? loadConfig;
        this.loadRegistry = opts.loadRegistry ?? loadRegistry;
        this.watcher = opts.watcher ?? nodeConfigWatcher;
    }

    // Eager initial load; a failure here is fatal (the app cannot start without
    // A valid config) so it rethrows.
    public init(): void {
        this.snapshot = this.read();
    }

    public get(): ConfigSnapshot {
        if (this.snapshot === undefined) {
            throw new Error("beflow: ConfigStore.get() called before init()");
        }
        return this.snapshot;
    }

    // Re-run the loaders; validate-before-swap. Never throws: a bad save keeps
    // The last-good snapshot and logs a warning.
    public reload(): void {
        let next: ConfigSnapshot;
        try {
            next = this.read();
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.log(`beflow: config reload failed: ${reason}; keeping previous config`);
            return;
        }
        this.snapshot = next;
        this.log("beflow: config reloaded");
    }

    public start(): void {
        if (this.unwatch !== undefined) {
            return;
        }
        const filePath = join(this.dir, "config.json");
        this.unwatch = this.watcher.watch(filePath, () => {
            this.reload();
        });
    }

    public stop(): void {
        if (this.unwatch === undefined) {
            return;
        }
        this.unwatch();
        this.unwatch = undefined;
    }

    private read(): ConfigSnapshot {
        return {
            config: this.loadConfig(this.dir),
            registry: this.loadRegistry(this.dir),
        };
    }
}
