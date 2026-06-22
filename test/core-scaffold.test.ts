import { describe, expect, it } from "bun:test";

import { parseAgentowners } from "../src/core/policy.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import { DEFAULT_AGENTOWNERS_PATH, RECOMMENDED_AGENTOWNERS, scaffoldAgentowners } from "../src/core/scaffold.ts";

function memFs(seed: Record<string, string> = {}): RunStoreFs & { files: Map<string, string> } {
    const files = new Map<string, string>(Object.entries(seed));
    return {
        files,
        list(dir) {
            return [...files.keys()].filter((p) => p.startsWith(dir));
        },
        read(path) {
            return files.get(path) ?? null;
        },
        remove(path) {
            files.delete(path);
        },
        append(path, data) {
            files.set(path, (files.get(path) ?? "") + data);
        },
        write(path, data) {
            files.set(path, data);
        },
    };
}

describe("scaffoldAgentowners", () => {
    it("writes the recommended content at the default path when absent", () => {
        const fs = memFs();
        const result = scaffoldAgentowners("/repo/bin", DEFAULT_AGENTOWNERS_PATH, fs);

        expect(result.written).toBe(true);
        expect(result.path).toBe("/repo/bin/.github/AGENTOWNERS");
        expect(fs.files.get(result.path)).toBe(RECOMMENDED_AGENTOWNERS);
        expect(RECOMMENDED_AGENTOWNERS).toContain("AGENTOWNERS");
    });

    it("honors a custom relative path (the location the evaluator reads)", () => {
        const fs = memFs();
        const result = scaffoldAgentowners("/repo/bin", "policy/AGENTOWNERS", fs);

        expect(result.written).toBe(true);
        expect(result.path).toBe("/repo/bin/policy/AGENTOWNERS");
        expect(fs.files.get("/repo/bin/policy/AGENTOWNERS")).toBe(RECOMMENDED_AGENTOWNERS);
    });

    it("honors an absolute path as-is", () => {
        const fs = memFs();
        const result = scaffoldAgentowners("/repo/bin", "/etc/beflow/AGENTOWNERS", fs);

        expect(result.written).toBe(true);
        expect(result.path).toBe("/etc/beflow/AGENTOWNERS");
    });

    it("never overwrites an existing AGENTOWNERS", () => {
        const existing = "src/** block\n";
        const fs = memFs({ "/repo/bin/.github/AGENTOWNERS": existing });
        const result = scaffoldAgentowners("/repo/bin", DEFAULT_AGENTOWNERS_PATH, fs);

        expect(result.written).toBe(false);
        expect(result.path).toBe("/repo/bin/.github/AGENTOWNERS");
        expect(fs.files.get(result.path)).toBe(existing);
    });
});

describe("RECOMMENDED_AGENTOWNERS", () => {
    it("is empty by default — parses to zero rules (no policy imposed until you add one)", () => {
        const rules = parseAgentowners(RECOMMENDED_AGENTOWNERS);
        expect(rules).toEqual([]);
    });
});
