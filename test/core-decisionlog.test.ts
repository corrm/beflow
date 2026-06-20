import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildDecisionEvent, LocalNdjsonSink, resolveDecisionsDir } from "../src/core/decisionlog.ts";
import type { NewDecisionEvent } from "../src/core/decisionlog.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";

function memFs(): { fs: RunStoreFs; store: Map<string, string> } {
    const store = new Map<string, string>();
    const fs: RunStoreFs = {
        list: (dir) => [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
        read: (path) => store.get(path) ?? null,
        remove: (path) => {
            store.delete(path);
        },
        write: (path, data) => {
            store.set(path, data);
        },
    };
    return { fs, store };
}

const fixedClock = (): string => "2026-06-20T00:00:00.000Z";
const fixedId = (): string => "decision-1";

function newEvent(over: Partial<NewDecisionEvent> = {}): NewDecisionEvent {
    return {
        changedFiles: ["src/a.ts"],
        decision: "allow",
        evaluator: "globs",
        key: "CG-42",
        matchedRules: [],
        prUrl: "https://gh/pr/9",
        reason: "no policy rule matched",
        runId: "CG-42@2026-06-20T00:00:00.000Z",
        ...over,
    };
}

function lines(store: Map<string, string>, dir: string): unknown[] {
    const raw = store.get(join(dir, "decisions.ndjson")) ?? "";
    return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line): unknown => JSON.parse(line));
}

describe("resolveDecisionsDir", () => {
    it("defaults to ~/.beflow/decisions (a sibling of runs)", () => {
        expect(resolveDecisionsDir()).toBe(join(homedir(), ".beflow", "decisions"));
    });

    it("expands and uses a configured dir", () => {
        expect(resolveDecisionsDir("~/decisions")).toBe(join(homedir(), "decisions"));
        expect(resolveDecisionsDir("/var/decisions")).toBe("/var/decisions");
    });
});

describe("buildDecisionEvent", () => {
    it("stamps the schema version, ids, timestamp, and hashes", () => {
        const event = buildDecisionEvent(newEvent(), fixedClock, fixedId);
        expect(event.schemaVersion).toBe(1);
        expect(event.decisionId).toBe("decision-1");
        expect(event.timestamp).toBe("2026-06-20T00:00:00.000Z");
        expect(event.changedFilesHash).toMatch(/^[0-9a-f]{64}$/);
        expect(event.decisionInputHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("carries the structured matchedRules through unchanged", () => {
        const matchedRules = [{ decision: "block" as const, paths: ["infra/**"] }];
        const event = buildDecisionEvent(newEvent({ decision: "block", matchedRules }), fixedClock, fixedId);
        expect(event.decision).toBe("block");
        expect(event.matchedRules).toEqual(matchedRules);
    });

    it("omits prUrl when not provided", () => {
        const event = buildDecisionEvent(newEvent({ prUrl: undefined }), fixedClock, fixedId);
        expect(event.prUrl).toBeUndefined();
    });

    it("changed-files hash is order-independent (sorted)", () => {
        const a = buildDecisionEvent(newEvent({ changedFiles: ["a", "b"] }), fixedClock, fixedId);
        const b = buildDecisionEvent(newEvent({ changedFiles: ["b", "a"] }), fixedClock, fixedId);
        expect(a.changedFilesHash).toBe(b.changedFilesHash);
    });

    it("decision-input hash changes when the decision changes", () => {
        const allow = buildDecisionEvent(newEvent({ decision: "allow" }), fixedClock, fixedId);
        const block = buildDecisionEvent(newEvent({ decision: "block" }), fixedClock, fixedId);
        expect(allow.decisionInputHash).not.toBe(block.decisionInputHash);
    });
});

describe("LocalNdjsonSink", () => {
    it("writes one NDJSON line that round-trips the emitted event verbatim", async () => {
        const { fs, store } = memFs();
        const sink = new LocalNdjsonSink("/decisions", fs);
        const event = buildDecisionEvent(newEvent(), fixedClock, fixedId);
        await sink.emit(event);
        const written = lines(store, "/decisions");
        expect(written).toHaveLength(1);
        expect(written[0]).toEqual(event);
    });

    it("appends (does not overwrite): successive emits accumulate in order", async () => {
        const { fs, store } = memFs();
        const sink = new LocalNdjsonSink("/decisions", fs);
        const emitted = [
            buildDecisionEvent(newEvent({ key: "CG-1" }), fixedClock, () => "d-1"),
            buildDecisionEvent(newEvent({ key: "CG-2" }), fixedClock, () => "d-2"),
            buildDecisionEvent(newEvent({ key: "CG-3" }), fixedClock, () => "d-3"),
        ];
        for (const event of emitted) {
            await sink.emit(event);
        }
        // All three lines persist in emit order — the prior content is never overwritten.
        expect(lines(store, "/decisions")).toEqual(emitted);
    });
});
