import type { DecisionEvent } from "./decisionlog.ts";

export const PREFLIGHT_BLOCK_MESSAGE =
    "This work item was moved to Needs Input because the file paths it declares fall under a control-plane block in the project's policy — an agent could not land this change as scoped. Please review and narrow the scope (or split out the blocked paths), then leave a comment, and beflow will pick it up automatically.";

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&gt;": ">",
    "&lt;": "<",
    "&nbsp;": " ",
};

function decodeBody(text: string): string {
    const stripped = text.replace(/<[^>]*>/g, " ");
    return stripped.replace(/&nbsp;|&amp;|&lt;|&gt;/g, (m) => ENTITIES[m] ?? m);
}

// A token is a confident repo-path candidate when it contains a path separator
// AND a file extension (foo/bar.ts), OR is a dotfile-rooted path (.github/...).
// Both shapes are deliberately strict: a bare word, a prose sentence, or a code
// identifier without a separator never qualifies, so a false "block" is rare.
const PATH_TOKEN = /^[\w./-]+\/[\w./-]+\.[A-Za-z]\w*$/;
const DOTFILE_PATH_TOKEN = /^\.[\w.-]+\/[\w./-]+$/;

function isUrlLike(token: string): boolean {
    return /^[a-z][\w+.-]*:\/\//i.test(token);
}

function looksLikeHostname(token: string): boolean {
    const firstSegment = token.split("/")[0] ?? "";
    return /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/i.test(firstSegment);
}

function looksLikePath(token: string): boolean {
    if (token.length === 0 || isUrlLike(token) || looksLikeHostname(token)) {
        return false;
    }
    return PATH_TOKEN.test(token) || DOTFILE_PATH_TOKEN.test(token);
}

/**
 * Extract confident repo-path candidates from an issue's title and body. The only
 * accepted signals are path-like tokens (a separator plus an extension, or a
 * dotfile-rooted path); prose, URLs, and bare identifiers are ignored. The result
 * is de-duped and order-preserving, and is empty when the issue declares no paths
 * — the preflight must never short-circuit on no signal.
 */
export function derivePreflightPaths(title: string, body: string): string[] {
    const text = `${decodeBody(title)} ${decodeBody(body)}`;
    const seen = new Set<string>();
    for (const raw of text.split(/[\s,;()[\]{}<>"'`]+/)) {
        const token = raw.replace(/[.,;:]+$/, "");
        if (looksLikePath(token)) {
            seen.add(token);
        }
    }
    return [...seen];
}

/** One prior decision whose changed files overlap the issue's declared scope. */
export interface HistoricalOverlap {
    /** The prior issue's key. */
    key: string;
    /** The prior decision that gates this overlap (only block / require_approval). */
    decision: "block" | "require_approval";
    /** The overlapping paths (intersection of prior changedFiles and declared paths). */
    paths: string[];
}

// Bounded lookback: only the most-recent slice of the durable log is consulted,
// so the advisory cost stays flat as the log grows for the lifetime of a project.
const MAX_HISTORY_EVENTS = 1000;

/**
 * Predictive, advisory consumer of the durable decision log (BEFLOW-18). Given
 * already-project-scoped events (the caller scopes them to avoid a run.ts import
 * cycle) and the issue's coarse declared paths, find the prior runs whose changed
 * files overlap that scope and were sent to `block` / `require_approval`. Pure: no
 * I/O, never throws, returns `[]` when nothing overlaps. Path matching is exact —
 * coarse declared paths and real changedFiles are both repo-relative file paths, so
 * exact match keeps false positives near zero. Only the most-recent
 * `MAX_HISTORY_EVENTS` are considered. This NEVER blocks — the live policy gate
 * remains authoritative; it only surfaces a heads-up.
 */
export function findHistoricalOverlaps(
    events: readonly DecisionEvent[],
    derivedPaths: readonly string[],
): HistoricalOverlap[] {
    const declared = new Set(derivedPaths);
    const recent = events.slice(-MAX_HISTORY_EVENTS);
    const overlaps: HistoricalOverlap[] = [];
    for (const event of recent) {
        if (event.decision !== "block" && event.decision !== "require_approval") {
            continue;
        }
        const seen = new Set<string>();
        const intersection: string[] = [];
        for (const file of event.changedFiles) {
            if (declared.has(file) && !seen.has(file)) {
                seen.add(file);
                intersection.push(file);
            }
        }
        if (intersection.length > 0) {
            overlaps.push({ decision: event.decision, key: event.key, paths: intersection });
        }
    }
    return overlaps;
}

/** Render one advisory overlap line; the warning is informational, never a park. */
export function formatHistoricalOverlap(overlap: HistoricalOverlap, currentKey: string): string {
    return `beflow: ${currentKey} — heads up: declared scope overlaps paths a prior run sent to ${overlap.decision} (${overlap.key}: ${overlap.paths.join(", ")}); proceeding — the live policy gate remains authoritative`;
}
