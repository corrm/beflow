import { z } from "zod";

import type { ChangeReceipt } from "../model/types.ts";

export type ReportStatus = "done" | "needs_input" | "blocked" | "failed";

export interface Report {
    status: ReportStatus;
    summary: string;
    prUrl?: string;
    questions?: string[];
    notes?: string;
    receipt?: ChangeReceipt;
}

/**
 * The single source of truth for the change-receipt shape (runstore reuses this).
 * `surfaceNotes` is a string-keyed record because zod's enum-keyed record is
 * exhaustive (it would demand every surface); keys SHOULD be `RiskSurface` values.
 */
export const receiptSchema = z.object({
    filesTouched: z.array(z.string()).optional(),
    intent: z.string(),
    nextDecision: z.string().optional(),
    riskSurfaces: z.array(z.enum(["app", "deps", "infra", "auth", "data", "ci"])),
    surfaceNotes: z.record(z.string(), z.string()).optional(),
    testsRun: z.array(z.string()).optional(),
    uncertainty: z.string().optional(),
});

const reportSchema = z.object({
    notes: z.string().optional(),
    prUrl: z.string().optional(),
    questions: z.array(z.string()).optional(),
    receipt: receiptSchema.optional(),
    status: z.enum(["done", "needs_input", "blocked", "failed"]),
    summary: z.string(),
});

// Matches a fenced block whose info string is exactly `beflow-report`
// (tolerating trailing whitespace after it and CRLF line endings). The `g`
// Flag lets us take the LAST block — the agent's final word.
const blockPattern = /```beflow-report[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export function extractReport(text: string): Report | null {
    let inner: string | null = null;
    for (const match of text.matchAll(blockPattern)) {
        inner = match[1] ?? null;
    }
    if (inner === null) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(inner);
    } catch {
        return null;
    }

    const result = reportSchema.safeParse(parsed);
    return result.success ? result.data : null;
}
