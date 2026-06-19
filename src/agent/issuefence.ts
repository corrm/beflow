import { z } from "zod";

export interface IssueFence {
    body: string;
    title?: string;
    type?: string;
    priority?: string;
    labels?: string[];
}

const issueFenceSchema = z.object({
    body: z.string(),
    labels: z.array(z.string()).optional(),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    title: z.string().optional(),
    type: z.string().optional(),
});

// Matches a fenced block whose info string is exactly `beflow-issue` (tolerating
// trailing whitespace after it and CRLF line endings). The `g` flag lets us take
// the LAST block — the agent's final word.
const blockPattern = /```beflow-issue[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export function extractIssueFence(text: string): IssueFence | null {
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

    const result = issueFenceSchema.safeParse(parsed);
    return result.success ? result.data : null;
}
