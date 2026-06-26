import { z } from "zod";

import type { AdvisorSeverity } from "../config/schema.ts";
import type { AgentDriver, AgentRunResult } from "./driver.ts";

export interface AdvisorVerdict {
    severity: AdvisorSeverity;
    note: string;
}

const verdictSchema = z.object({
    severity: z.enum(["aside", "concern", "blocker"]),
    note: z.string(),
});

// Matches a fenced block whose info string is exactly `beflow-advisor`,
// mirroring `extractReport`'s `beflow-report` block: tolerate trailing
// whitespace and CRLF, take the LAST block as the deputy's final word.
const blockPattern = /```beflow-advisor[^\S\r\n]*\r?\n([\s\S]*?)```/g;

export function extractVerdict(text: string): AdvisorVerdict | null {
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

    const result = verdictSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

const ADVISOR_INSTRUCTION =
    "You are beflow's deputy reviewer. Review the committed work below against the contract. " +
    "You are read-only: do not edit files. End your turn with a single fenced block whose info " +
    'string is exactly `beflow-advisor` containing JSON {"severity": "aside"|"concern"|"blocker", ' +
    '"note": "<one sentence>"}. ' +
    "Use `aside` when the work satisfies the ticket, `concern` when it drifts and the agent should be " +
    "corrected, `blocker` when it is unsafe or fundamentally wrong. Speak rarely; do not nitpick taste.";

export function buildAdvisorTask(contract: string, diff: string): string {
    return `${ADVISOR_INSTRUCTION}\n\n## Contract (rubric)\n${contract}\n\n## Committed work (diff)\n${diff}`;
}

export interface ReviewArgs {
    driver: AgentDriver;
    sessionKey: string;
    cwd: string;
    acpCommand: string;
    contract: string;
    diff: string;
    timeoutSeconds?: number;
}

/**
 * Run the deputy as its own read-only acpx session (`<ISSUE-KEY>-advisor`) over
 * the committed diff + contract, and return its parsed verdict. Returns null when
 * the deputy emitted no parseable verdict — the caller treats that as "no action",
 * so a malformed review can never derail a run.
 */
export async function reviewWork(args: ReviewArgs): Promise<AdvisorVerdict | null> {
    const result: AgentRunResult = await args.driver.run({
        acpCommand: args.acpCommand,
        cwd: args.cwd,
        nonInteractive: "fail",
        runMode: "supervised",
        sessionKey: args.sessionKey,
        suppressReads: true,
        task: buildAdvisorTask(args.contract, args.diff),
        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
    });
    return extractVerdict(result.stream.assistantText);
}
