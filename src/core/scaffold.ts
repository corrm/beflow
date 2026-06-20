import { join } from "node:path";

import type { RunStoreFs } from "./runstore.ts";
import { nodeRunStoreFs } from "./runstore.ts";
import recommendedAgentowners from "./scaffold/agentowners.default" with { type: "text" };

/** The compiled-in recommended control-plane AGENTOWNERS content. */
export const RECOMMENDED_AGENTOWNERS = recommendedAgentowners;

export interface ScaffoldResult {
    path: string;
    written: boolean;
}

/**
 * Write the recommended control-plane AGENTOWNERS into `<repoPath>/.github/AGENTOWNERS`.
 * Never overwrites an existing file: when one is already present, returns
 * `{ written: false }` and leaves it untouched.
 */
export function scaffoldAgentowners(repoPath: string, fs: RunStoreFs = nodeRunStoreFs): ScaffoldResult {
    const path = join(repoPath, ".github", "AGENTOWNERS");
    if (fs.read(path) !== null) {
        return { path, written: false };
    }
    fs.write(path, RECOMMENDED_AGENTOWNERS);
    return { path, written: true };
}
