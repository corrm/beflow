import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { spawn } from "bun";

import {
    buildDecisionEvent,
    LocalNdjsonSink,
    readDecisionEvents,
    resolveDecisionsDir,
} from "../src/core/decisionlog.ts";
import type { NewDecisionEvent } from "../src/core/decisionlog.ts";
import { nodeRunStoreFs } from "../src/core/runstore.ts";
import type { RunStoreFs } from "../src/core/runstore.ts";

function memFs(): { fs: RunStoreFs; store: Map<string, string> } {
    const store = new Map<string, string>();
    const fs: RunStoreFs = {
        append: (path, data) => {
            store.set(path, `${store.get(path) ?? ""}${data}`);
        },
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

interface FsCall {
    method: keyof RunStoreFs;
    args: unknown[];
}

function spyFs(): { fs: RunStoreFs; calls: FsCall[] } {
    const calls: FsCall[] = [];
    const store = new Map<string, string>();
    const fs: RunStoreFs = {
        append: (path, data) => {
            calls.push({ args: [path, data], method: "append" });
            store.set(path, `${store.get(path) ?? ""}${data}`);
        },
        list: (dir) => {
            calls.push({ args: [dir], method: "list" });
            return [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
        },
        read: (path) => {
            calls.push({ args: [path], method: "read" });
            return store.get(path) ?? null;
        },
        remove: (path) => {
            calls.push({ args: [path], method: "remove" });
            store.delete(path);
        },
        write: (path, data) => {
            calls.push({ args: [path, data], method: "write" });
            store.set(path, data);
        },
    };
    return { calls, fs };
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

    it("emit is a single atomic append — never read-then-write", async () => {
        const { calls, fs } = spyFs();
        const sink = new LocalNdjsonSink("/decisions", fs);
        const event = buildDecisionEvent(newEvent(), fixedClock, fixedId);
        await sink.emit(event);
        expect(calls).toEqual([
            { args: [join("/decisions", "decisions.ndjson"), `${JSON.stringify(event)}\n`], method: "append" },
        ]);
        expect(calls.some((c) => c.method === "write")).toBe(false);
        expect(calls.some((c) => c.method === "read")).toBe(false);
    });
});

describe("LocalNdjsonSink (real fs, concurrent writers)", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "beflow-decisions-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("two sink instances on the same file accumulate, never clobber", async () => {
        const sinkA = new LocalNdjsonSink(dir, nodeRunStoreFs);
        const sinkB = new LocalNdjsonSink(dir, nodeRunStoreFs);
        const count = 100;
        const events = Array.from({ length: count }, (_, i) =>
            buildDecisionEvent(newEvent({ key: `CG-${String(i)}` }), fixedClock, () => `d-${String(i)}`),
        );
        await Promise.all(
            events.map(async (event, i) => {
                const sink = i % 2 === 0 ? sinkA : sinkB;
                await sink.emit(event);
            }),
        );
        const read = readDecisionEvents(dir, nodeRunStoreFs);
        expect(read).toHaveLength(count);
        expect(new Set(read.map((e) => e.decisionId))).toEqual(new Set(events.map((e) => e.decisionId)));
    });

    it("loses no lines when two OS processes O_APPEND the same file concurrently", async () => {
        const target = join(dir, "decisions.ndjson");
        const perProc = 200;
        const appender = join(dir, "appender.ts");
        writeFileSync(
            appender,
            [
                'import { appendFileSync } from "node:fs";',
                "const [target, prefix, count] = process.argv.slice(2);",
                "for (let i = 0; i < Number(count); i++) {",
                '    appendFileSync(target, `${prefix}-${String(i)}\\n`, "utf8");',
                "}",
                "",
            ].join("\n"),
            "utf8",
        );

        const procA = spawn(["bun", appender, target, "procA", String(perProc)]);
        const procB = spawn(["bun", appender, target, "procB", String(perProc)]);
        const [exitA, exitB] = await Promise.all([procA.exited, procB.exited]);
        expect(exitA).toBe(0);
        expect(exitB).toBe(0);

        const written = readFileSync(target, "utf8")
            .split("\n")
            .filter((line) => line.length > 0);
        expect(written).toHaveLength(perProc * 2);
        const fromA = written.filter((line) => line.startsWith("procA-"));
        const fromB = written.filter((line) => line.startsWith("procB-"));
        expect(new Set(fromA)).toEqual(new Set(Array.from({ length: perProc }, (_, i) => `procA-${String(i)}`)));
        expect(new Set(fromB)).toEqual(new Set(Array.from({ length: perProc }, (_, i) => `procB-${String(i)}`)));
    });
});

describe("readDecisionEvents", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "beflow-decisions-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("returns [] when the log file is absent", () => {
        expect(readDecisionEvents(dir, nodeRunStoreFs)).toEqual([]);
    });

    it("recovers all valid events and silently drops a torn trailing line", () => {
        const valid = [
            buildDecisionEvent(newEvent({ key: "CG-1" }), fixedClock, () => "d-1"),
            buildDecisionEvent(newEvent({ key: "CG-2" }), fixedClock, () => "d-2"),
        ];
        const path = join(dir, "decisions.ndjson");
        writeFileSync(path, valid.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
        appendFileSync(path, JSON.stringify(newEvent({ key: "CG-3" })).slice(0, 30), "utf8");
        expect(readDecisionEvents(dir, nodeRunStoreFs)).toEqual(valid);
    });
});
