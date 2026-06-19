import { z } from "zod";

export type ReportStatus = "done" | "needs_input" | "blocked" | "failed";

export interface Report {
    status: ReportStatus;
    summary: string;
    prUrl?: string;
    questions?: string[];
    notes?: string;
}

const reportSchema = z.object({
    notes: z.string().optional(),
    prUrl: z.string().optional(),
    questions: z.array(z.string()).optional(),
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
