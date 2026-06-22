import type { Config, Registry } from "../config/schema.ts";
import { createLinearTracker } from "./linear/adapter.ts";
import { createPlaneTracker, verifyPlaneConfig } from "./plane/adapter.ts";
import type { Tracker } from "./tracker.ts";

export function createTracker(config: Config, registry: Registry, env: NodeJS.ProcessEnv = process.env): Tracker {
    switch (config.tracker) {
        case "plane":
            return createPlaneTracker(config, registry, env);
        case "linear":
            return createLinearTracker(config, registry, env);
        default: {
            const exhaustive: never = config.tracker;
            throw new Error(`unknown tracker "${String(exhaustive)}"`);
        }
    }
}

// Static, network-free validation of the active tracker's config block. Throws a
// clear, actionable error when the block is present but not yet usable. Operates
// on config alone — no instance, no API key, no network — so doctor can run it
// even when the key is unset or the tracker cannot be constructed.
export function verifyTrackerConfig(config: Config): void {
    switch (config.tracker) {
        case "plane": {
            const plane = config.trackers.plane;
            if (plane !== undefined) {
                verifyPlaneConfig(plane);
            }
            return;
        }
        case "linear":
            return;
        default: {
            const exhaustive: never = config.tracker;
            throw new Error(`unknown tracker "${String(exhaustive)}"`);
        }
    }
}
