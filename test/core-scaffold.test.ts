import { describe, expect, it } from "bun:test";

import { parseAgentowners } from "../src/core/policy.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";
import { RECOMMENDED_AGENTOWNERS, scaffoldAgentowners } from "../src/core/scaffold.ts";

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
    it("writes the recommended content into .github/AGENTOWNERS when absent", () => {
        const fs = memFs();
        const result = scaffoldAgentowners("/repo/bin", fs);

        expect(result.written).toBe(true);
        expect(result.path).toBe("/repo/bin/.github/AGENTOWNERS");
        expect(fs.files.get(result.path)).toBe(RECOMMENDED_AGENTOWNERS);
        expect(RECOMMENDED_AGENTOWNERS).toContain("tests/** require_approval");
        expect(RECOMMENDED_AGENTOWNERS).toContain(".github/** require_approval");
    });

    it("never overwrites an existing AGENTOWNERS", () => {
        const existing = "src/** block\n";
        const fs = memFs({ "/repo/bin/.github/AGENTOWNERS": existing });
        const result = scaffoldAgentowners("/repo/bin", fs);

        expect(result.written).toBe(false);
        expect(result.path).toBe("/repo/bin/.github/AGENTOWNERS");
        expect(fs.files.get(result.path)).toBe(existing);
    });
});

describe("RECOMMENDED_AGENTOWNERS", () => {
    it("parses through the real agentowners parser as require_approval rules", () => {
        const rules = parseAgentowners(RECOMMENDED_AGENTOWNERS);

        expect(rules).toEqual([
            { decision: "require_approval", paths: ["tests/**"] },
            { decision: "require_approval", paths: [".github/**"] },
        ]);
    });
});
