import { isAbsolute, join } from "node:path";

import type { RunStoreFs } from "./runstore.ts";
import { nodeRunStoreFs } from "./runstore.ts";
import recommendedAgentowners from "./scaffold/agentowners.default" with { type: "text" };

/** The compiled-in recommended control-plane AGENTOWNERS content. */
export const RECOMMENDED_AGENTOWNERS = recommendedAgentowners;

/** The default location, used when policy.agentownersPath is unset. */
export const DEFAULT_AGENTOWNERS_PATH = ".github/AGENTOWNERS";

export interface ScaffoldResult {
    path: string;
    written: boolean;
}

/**
 * Write the recommended control-plane AGENTOWNERS at `ownersPath` (relative to
 * `repoPath`, or used as-is when absolute) — the SAME location the agentowners
 * evaluator reads, so the gate always has the file it was pointed at. Never
 * overwrites: when a file is already present, returns `{ written: false }`.
 */
export function scaffoldAgentowners(
    repoPath: string,
    ownersPath: string = DEFAULT_AGENTOWNERS_PATH,
    fs: RunStoreFs = nodeRunStoreFs,
): ScaffoldResult {
    const path = isAbsolute(ownersPath) ? ownersPath : join(repoPath, ownersPath);
    if (fs.read(path) !== null) {
        return { path, written: false };
    }
    fs.write(path, RECOMMENDED_AGENTOWNERS);
    return { path, written: true };
}
