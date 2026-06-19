import type { Config, Registry } from "../config/schema.ts";
import { createLinearTracker } from "./linear/adapter.ts";
import { createPlaneTracker } from "./plane/adapter.ts";
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
