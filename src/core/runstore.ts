import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { receiptSchema } from "../agent/report.ts";
import { xdgStateHome } from "../config/xdg.ts";
import { expandHome, sanitizeKey } from "./worktree.ts";

export const reportSchema = z.object({
    notes: z.string().optional(),
    prUrl: z.string().optional(),
    questions: z.array(z.string()).optional(),
    receipt: receiptSchema.optional(),
    status: z.enum(["done", "needs_input", "blocked", "failed"]),
    summary: z.string(),
});

export const usageSchema = z.object({
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
});

export const runRecordSchema = z.object({
    agent: z.string(),
    attempts: z.number().optional(),
    branch: z.string().optional(),
    ciAttempts: z.number().optional(),
    ciReworkSha: z.string().optional(),
    cwd: z.string(),
    escalatedAt: z.string().optional(),
    heldReason: z.enum(["decision", "quarantine"]).optional(),
    jobKind: z.enum(["triage", "spec", "implement"]),
    key: z.string(),
    prUrl: z.string().optional(),
    repoPath: z.string().optional(),
    report: reportSchema.optional(),
    reviewedSha: z.string().optional(),
    runMode: z.enum(["autonomous", "supervised"]),
    sessionName: z.string(),
    status: z.enum(["in_progress", "done", "needs_input", "blocked", "failed"]),
    tracker: z.enum(["plane", "linear"]).optional(),
    updatedAt: z.string(),
    usage: usageSchema.optional(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

/** Resolve the run-record base dir: the configured value (~-expanded) or the default. */
export function resolveRunsDir(configured?: string): string {
    return configured !== undefined ? expandHome(configured) : join(xdgStateHome(), "runs");
}

function recordPath(runsDir: string, key: string): string {
    return join(runsDir, `${sanitizeKey(key)}.json`);
}

export interface RunStoreFs {
    read(path: string): string | null;
    write(path: string, data: string): void;
    append(path: string, data: string): void;
    remove(path: string): void;
    list(dir: string): string[];
}

export const nodeRunStoreFs: RunStoreFs = {
    append(path, data) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, data, "utf8");
    },
    list(dir) {
        try {
            return readdirSync(dir);
        } catch {
            return [];
        }
    },
    read(path) {
        try {
            return readFileSync(path, "utf8");
        } catch {
            return null;
        }
    },
    remove(path) {
        rmSync(path, { force: true });
    },
    write(path, data) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data, "utf8");
    },
};

export type Clock = () => string;

export function systemClock(): string {
    return new Date().toISOString();
}

export function loadRecord(runsDir: string, key: string, fs: RunStoreFs = nodeRunStoreFs): RunRecord | null {
    const raw = fs.read(recordPath(runsDir, key));
    if (raw === null) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    const result = runRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

export function listRecords(runsDir: string, fs: RunStoreFs = nodeRunStoreFs): RunRecord[] {
    const records: RunRecord[] = [];
    for (const name of fs.list(runsDir)) {
        if (!name.endsWith(".json")) {
            continue;
        }
        const raw = fs.read(join(runsDir, name));
        if (raw === null) {
            continue;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            continue;
        }
        const result = runRecordSchema.safeParse(parsed);
        if (result.success) {
            records.push(result.data);
        }
    }
    return records;
}

export function saveRecord(runsDir: string, record: RunRecord, fs: RunStoreFs = nodeRunStoreFs): void {
    fs.write(recordPath(runsDir, record.key), `${JSON.stringify(record, null, 2)}\n`);
}

export function deleteRecord(runsDir: string, key: string, fs: RunStoreFs = nodeRunStoreFs): void {
    fs.remove(recordPath(runsDir, key));
}
