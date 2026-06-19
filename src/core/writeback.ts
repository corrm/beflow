import type { Report } from "../agent/report.ts";
import type { Issue, JobKind } from "../model/types.ts";
import type { Tracker } from "../trackers/tracker.ts";

const BLOCKED_LABEL = "blocked";
const FAILED_LABEL = "failed";
const TRIAGED_LABEL = "triaged";
const NEEDS_INPUT_STATE = "Needs Input";

export interface WritebackResult {
    movedTo?: string;
    labeled?: string;
}

const DONE_STATES: Record<JobKind, string> = {
    implement: "In Review",
    spec: "Todo",
    triage: "Backlog",
};

export function defaultDoneState(jobKind: JobKind): string {
    return DONE_STATES[jobKind];
}

export function buildCommentBody(report: Report, telemetry?: string): string {
    const parts = [report.summary];
    if (report.notes !== undefined && report.notes.trim() !== "") {
        parts.push(report.notes);
    }
    if (report.questions !== undefined && report.questions.length > 0) {
        const list = report.questions.map((q) => `- ${q}`).join("\n");
        parts.push(`Questions:\n${list}`);
    }
    if (telemetry !== undefined && telemetry.trim() !== "") {
        parts.push(telemetry);
    }
    return parts.join("\n\n");
}

export async function applyReport(
    tracker: Tracker,
    issue: Issue,
    report: Report,
    jobKind: JobKind,
    telemetry?: string,
): Promise<WritebackResult> {
    if (report.prUrl !== undefined && report.prUrl !== "") {
        await tracker.linkPR(issue, report.prUrl);
    }

    await tracker.comment(issue, buildCommentBody(report, telemetry));

    const result: WritebackResult = {};

    switch (report.status) {
        case "done": {
            const target = defaultDoneState(jobKind);
            await tracker.updateState(issue, target);
            result.movedTo = target;
            if (jobKind === "triage") {
                await tracker.addProperty(issue, TRIAGED_LABEL);
                result.labeled = TRIAGED_LABEL;
            }
            break;
        }
        case "needs_input": {
            await tracker.updateState(issue, NEEDS_INPUT_STATE);
            result.movedTo = NEEDS_INPUT_STATE;
            break;
        }
        case "blocked": {
            await tracker.addProperty(issue, BLOCKED_LABEL);
            await tracker.updateState(issue, NEEDS_INPUT_STATE);
            result.labeled = BLOCKED_LABEL;
            result.movedTo = NEEDS_INPUT_STATE;
            break;
        }
        case "failed": {
            await tracker.addProperty(issue, FAILED_LABEL);
            await tracker.updateState(issue, NEEDS_INPUT_STATE);
            result.labeled = FAILED_LABEL;
            result.movedTo = NEEDS_INPUT_STATE;
            break;
        }
    }

    return result;
}
