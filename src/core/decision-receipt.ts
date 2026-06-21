import type { Issue, PolicyDecision } from "../model/types.ts";
import type { Tracker } from "../trackers/tracker.ts";
import type { DecisionEvent, DecisionEvidence, DecisionSink } from "./decisionlog.ts";
import { renderTemplate } from "./prompts.ts";
import type { Logger } from "./run.ts";

const FILE_LIST_CAP = 20;
const SURFACE_NOTES_CAP = 20;

const DECISION_LABELS: Record<PolicyDecision, string> = {
    allow: "ALLOW",
    block: "BLOCK",
    require_approval: "REQUIRE APPROVAL",
};

// Pre-composes the capped, indented file list (leading "\n" so the template can
// drop it inline and stay clean when there are no changed files).
function composeChangedFilesList(changedFiles: readonly string[]): string {
    if (changedFiles.length === 0) {
        return "";
    }
    const shown = changedFiles.slice(0, FILE_LIST_CAP);
    const lines = shown.map((file) => `  - \`${file}\``);
    const remaining = changedFiles.length - shown.length;
    if (remaining > 0) {
        lines.push(`  - +${String(remaining)} more`);
    }
    return `\n${lines.join("\n")}`;
}

// Pre-composes the capped, indented surface-notes list from the receipt evidence
// (leading "\n" so the template drops it inline and stays clean when there are no
// notes) — mirroring composeChangedFilesList.
function composeSurfaceNotesList(surfaceNotes: DecisionEvidence["surfaceNotes"]): string {
    if (surfaceNotes === undefined) {
        return "";
    }
    const entries = Object.entries(surfaceNotes);
    if (entries.length === 0) {
        return "";
    }
    const shown = entries.slice(0, SURFACE_NOTES_CAP);
    const lines = shown.map(([surface, note]) => `  - \`${surface}\`: ${note}`);
    const remaining = entries.length - shown.length;
    if (remaining > 0) {
        lines.push(`  - +${String(remaining)} more`);
    }
    return `\n${lines.join("\n")}`;
}

/**
 * The render context for the decision-receipt template: raw event fields plus a
 * handful of pre-composed convenience values (`changedFilesList`, `prLine`, and
 * the receipt-derived `intentLine` / `riskSurfacesLine` / `surfaceNotesList`)
 * that carry their own leading newline so empty sections vanish cleanly —
 * mirroring `renderContract`'s pre-composition idiom.
 */
export function buildReceiptContext(event: DecisionEvent): Record<string, string> {
    const intentLine = event.evidence !== undefined ? `\n- Agent intent: ${event.evidence.intent}` : "";
    const riskSurfacesLine =
        event.evidence !== undefined && event.evidence.riskSurfaces.length > 0
            ? `\n- Risk surfaces: ${event.evidence.riskSurfaces.join(", ")}`
            : "";
    const surfaceNotesList = event.evidence !== undefined ? composeSurfaceNotesList(event.evidence.surfaceNotes) : "";
    return {
        changedFilesList: composeChangedFilesList(event.changedFiles),
        decision: DECISION_LABELS[event.decision],
        evaluator: event.evaluator,
        fileCount: String(event.changedFiles.length),
        intentLine,
        key: event.key,
        prLine: event.prUrl !== undefined ? `\n- PR: ${event.prUrl}` : "",
        prUrl: event.prUrl ?? "",
        reason: event.reason,
        riskSurfacesLine,
        runId: event.runId,
        surfaceNotesList,
        timestamp: event.timestamp,
    };
}

/** Render the human-readable receipt body a reviewer glances at to approve/merge. */
export function formatReceiptBody(template: string, event: DecisionEvent): string {
    return renderTemplate("decision-receipt", template, buildReceiptContext(event));
}

/**
 * Surfaces each governed policy decision as a receipt comment on the tracker
 * issue — a new class behind the `DecisionSink` contract, so the durable log is
 * untouched. Best-effort by design: a tracker outage — or a broken custom
 * template that makes `renderTemplate` throw — logs and is swallowed so it can
 * never fail the run or lose the already-written NDJSON event. The adapter's
 * `comment` adds the bot marker, so no marker is hand-rolled here.
 */
export class TrackerCommentSink implements DecisionSink {
    public constructor(
        private readonly tracker: Tracker,
        private readonly issue: Issue,
        private readonly template: string,
        private readonly log: Logger,
    ) {}

    public async emit(event: DecisionEvent): Promise<void> {
        try {
            await this.tracker.comment(this.issue, formatReceiptBody(this.template, event));
        } catch (err) {
            this.log(
                `beflow: ${event.key} — decision receipt comment failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}
