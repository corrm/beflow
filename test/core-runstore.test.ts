import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { xdgStateHome } from "../src/config/xdg.ts";
import {
    deleteRecord,
    listRecords,
    loadRecord,
    nodeRunStoreFs,
    resolveRunsDir,
    saveRecord,
} from "../src/core/runstore.ts";
import type { RunRecord, RunStoreFs } from "../src/core/runstore.ts";
import type { ChangeReceipt } from "../src/model/types.ts";

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

function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
    return {
        agent: "claude",
        branch: "beflow/cg-42",
        cwd: "/wt/cg-42",
        key: "CG-42",
        jobKind: "implement",
        runMode: "autonomous",
        sessionName: "CG-42",
        status: "in_progress",
        updatedAt: "2026-06-14T00:00:00.000Z",
        ...over,
    };
}

describe("runstore roundtrip", () => {
    it("saves then loads an identical record", () => {
        const { fs } = memFs();
        const record = makeRecord();
        saveRecord("/runs", record, fs);
        expect(loadRecord("/runs", "CG-42", fs)).toEqual(record);
    });

    it("round-trips reviewedSha", () => {
        const { fs } = memFs();
        const record = makeRecord({ reviewedSha: "deadbeef", status: "done" });
        saveRecord("/runs", record, fs);
        expect(loadRecord("/runs", "CG-42", fs)?.reviewedSha).toBe("deadbeef");
    });

    it("round-trips usage (tokens + cost)", () => {
        const { fs } = memFs();
        const record = makeRecord({
            status: "done",
            usage: { cacheReadTokens: 12, costUsd: 0.05, inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        });
        saveRecord("/runs", record, fs);
        expect(loadRecord("/runs", "CG-42", fs)?.usage).toEqual({
            cacheReadTokens: 12,
            costUsd: 0.05,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
        });
    });

    it("round-trips usage with cacheWriteTokens", () => {
        const { fs } = memFs();
        const record = makeRecord({
            status: "done",
            usage: {
                cacheReadTokens: 14072,
                cacheWriteTokens: 3798,
                inputTokens: 8064,
                outputTokens: 5,
                totalTokens: 25939,
            },
        });
        saveRecord("/runs", record, fs);
        expect(loadRecord("/runs", "CG-42", fs)?.usage).toEqual({
            cacheReadTokens: 14072,
            cacheWriteTokens: 3798,
            inputTokens: 8064,
            outputTokens: 5,
            totalTokens: 25939,
        });
    });

    it("round-trips a report change receipt", () => {
        const { fs } = memFs();
        const receipt: ChangeReceipt = {
            filesTouched: ["src/api/auth.ts"],
            intent: "add a login route",
            riskSurfaces: ["app", "auth"],
            surfaceNotes: { auth: "no change to token signing" },
        };
        const record = makeRecord({
            report: { receipt, status: "done", summary: "shipped" },
            status: "done",
        });
        saveRecord("/runs", record, fs);
        expect(loadRecord("/runs", "CG-42", fs)?.report?.receipt).toEqual(receipt);
    });

    it("keys the file by sanitized key", () => {
        const { fs, store } = memFs();
        saveRecord("/runs", makeRecord(), fs);
        expect([...store.keys()]).toEqual([join("/runs", "cg-42.json")]);
    });
});

describe("loadRecord", () => {
    it("returns null when the record is missing", () => {
        const { fs } = memFs();
        expect(loadRecord("/runs", "CG-99", fs)).toBeNull();
    });

    it("returns null when the record is malformed JSON", () => {
        const { fs } = memFs();
        fs.write(join("/runs", "cg-42.json"), "{not json");
        expect(loadRecord("/runs", "CG-42", fs)).toBeNull();
    });

    it("returns null when the shape is invalid", () => {
        const { fs } = memFs();
        fs.write(join("/runs", "cg-42.json"), JSON.stringify({ key: "CG-42" }));
        expect(loadRecord("/runs", "CG-42", fs)).toBeNull();
    });
});

describe("deleteRecord", () => {
    it("removes an existing record", () => {
        const { fs } = memFs();
        saveRecord("/runs", makeRecord(), fs);
        deleteRecord("/runs", "CG-42", fs);
        expect(loadRecord("/runs", "CG-42", fs)).toBeNull();
    });

    it("is a no-op when absent", () => {
        const { fs } = memFs();
        expect(() => {
            deleteRecord("/runs", "CG-42", fs);
        }).not.toThrow();
    });
});

describe("listRecords", () => {
    it("returns every parsed valid record in the dir", () => {
        const { fs } = memFs();
        saveRecord("/runs", makeRecord({ key: "CG-1" }), fs);
        saveRecord("/runs", makeRecord({ key: "CG-2" }), fs);
        const keys = listRecords("/runs", fs)
            .map((r) => r.key)
            .sort();
        expect(keys).toEqual(["CG-1", "CG-2"]);
    });

    it("uses record.key from content, not the sanitized filename", () => {
        const { fs, store } = memFs();
        saveRecord("/runs", makeRecord({ key: "CG-42" }), fs);
        // The file is keyed by sanitized "cg-42.json", but the parsed key is "CG-42".
        expect([...store.keys()]).toEqual([join("/runs", "cg-42.json")]);
        expect(listRecords("/runs", fs).map((r) => r.key)).toEqual(["CG-42"]);
    });

    it("returns [] for a missing dir", () => {
        const { fs } = memFs();
        expect(listRecords("/nope", fs)).toEqual([]);
    });

    it("skips files that are not .json", () => {
        const { fs } = memFs();
        saveRecord("/runs", makeRecord({ key: "CG-1" }), fs);
        fs.write(join("/runs", "README.txt"), "not a record");
        expect(listRecords("/runs", fs).map((r) => r.key)).toEqual(["CG-1"]);
    });

    it("skips malformed JSON", () => {
        const { fs } = memFs();
        saveRecord("/runs", makeRecord({ key: "CG-1" }), fs);
        fs.write(join("/runs", "broken.json"), "{not json");
        expect(listRecords("/runs", fs).map((r) => r.key)).toEqual(["CG-1"]);
    });

    it("skips schema-invalid content", () => {
        const { fs } = memFs();
        saveRecord("/runs", makeRecord({ key: "CG-1" }), fs);
        fs.write(join("/runs", "invalid.json"), JSON.stringify({ key: "CG-9" }));
        expect(listRecords("/runs", fs).map((r) => r.key)).toEqual(["CG-1"]);
    });
});

describe("nodeRunStoreFs.append (real fs)", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "beflow-runstore-"));
    });

    afterEach(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("appends without truncating: successive appends concatenate in order", () => {
        const path = join(dir, "log.ndjson");
        nodeRunStoreFs.append(path, "first\n");
        nodeRunStoreFs.append(path, "second\n");
        expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    });

    it("append after write keeps the written content, then adds to it", () => {
        const path = join(dir, "log.ndjson");
        nodeRunStoreFs.write(path, "base\n");
        nodeRunStoreFs.append(path, "more\n");
        expect(readFileSync(path, "utf8")).toBe("base\nmore\n");
    });
});

describe("resolveRunsDir", () => {
    it("defaults under the XDG state home when unconfigured", () => {
        expect(resolveRunsDir()).toBe(join(xdgStateHome(), "runs"));
    });
    it("expands and uses a configured dir", () => {
        expect(resolveRunsDir("~/runs")).toBe(join(homedir(), "runs"));
        expect(resolveRunsDir("/var/runs")).toBe("/var/runs");
    });
});
