import type { Report } from "../agent/report.ts";
import type { Issue } from "../model/types.ts";
import type { Comment, Tracker } from "../trackers/tracker.ts";
import type { PromptSet } from "./prompts.ts";
import { renderTemplate } from "./prompts.ts";
import type { RunRecord } from "./runstore.ts";

export interface ContinuationContext {
    newComments: Comment[];
    prUrl?: string;
    priorReport?: Report;
}

export interface AssembleOptions {
    since?: string;
    record?: RunRecord | null;
}

export async function assembleContinuation(
    tracker: Tracker,
    issue: Issue,
    opts: AssembleOptions = {},
): Promise<ContinuationContext> {
    const all = await tracker.listComments(issue);

    const newComments = all.filter((c) => {
        if (c.isBot) {
            return false;
        }
        if (opts.since !== undefined) {
            if (!c.createdAt) {
                return false;
            }
            return c.createdAt > opts.since;
        }
        return true;
    });

    return {
        newComments,
        ...(opts.record?.prUrl !== undefined ? { prUrl: opts.record.prUrl } : {}),
        ...(opts.record?.report !== undefined ? { priorReport: opts.record.report } : {}),
    };
}

export function renderContinuation(prompts: PromptSet, ctx: ContinuationContext): string {
    const priorReport =
        ctx.priorReport !== undefined ? `${ctx.priorReport.status} — ${ctx.priorReport.summary}` : "(none)";
    const prUrl = ctx.prUrl ?? "(none)";
    const reviewComments =
        ctx.newComments.length > 0 ? ctx.newComments.map((c) => `- ${c.body}`).join("\n") : "No new comments.";
    return renderTemplate("continuation", prompts.continuation, {
        pr_url: prUrl,
        prior_report: priorReport,
        review_comments: reviewComments,
    });
}
