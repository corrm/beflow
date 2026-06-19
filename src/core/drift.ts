import type { BoardTemplate, BoardState, Tracker } from "../trackers/tracker.ts";

// States beflow operationally depends on (queue + writeback targets).
export const REQUIRED_STATES = ["Backlog", "Todo", "In Progress", "Needs Input", "In Review", "Done"];
// Labels beflow's writeback creates/uses.
export const REQUIRED_LABELS = ["blocked", "quarantined", "triaged"];

export interface DriftReport {
    missingStates: string[]; // In template, absent on tracker
    missingLabels: string[];
    missingModules: string[];
    extraStates: string[]; // On tracker, not in template (helps spot renames)
}

export function boardDrift(template: BoardTemplate, board: BoardState): DriftReport {
    const boardStates = new Set(board.states);
    const boardLabels = new Set(board.labels);
    const boardModules = new Set(board.modules);
    const templateStates = new Set(template.states.map((s) => s.name));

    return {
        extraStates: board.states.filter((name) => !templateStates.has(name)),
        missingLabels: template.labels.map((l) => l.name).filter((name) => !boardLabels.has(name)),
        missingModules: template.modules.map((m) => m.name).filter((name) => !boardModules.has(name)),
        missingStates: template.states.map((s) => s.name).filter((name) => !boardStates.has(name)),
    };
}

// Pre-run guard: throws a clear, actionable error if a REQUIRED state/label is
// Missing. If the board cannot be inspected (network / not implemented), it logs
// And PROCEEDS (inability to verify is not the same as drift).
export async function assertBoardReady(projectKey: string, tracker: Tracker, log?: (m: string) => void): Promise<void> {
    let board: BoardState;
    try {
        board = await tracker.inspectBoard(projectKey);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.(`beflow: could not verify board for ${projectKey} (${msg}); proceeding`);
        return;
    }

    const missingStates = REQUIRED_STATES.filter((s) => !board.states.includes(s));
    const missingLabels = REQUIRED_LABELS.filter((l) => !board.labels.includes(l));
    if (missingStates.length === 0 && missingLabels.length === 0) {
        return;
    }

    const parts: string[] = [];
    if (missingStates.length > 0) {
        parts.push(`state(s): ${missingStates.join(", ")}`);
    }
    if (missingLabels.length > 0) {
        parts.push(`label(s): ${missingLabels.join(", ")}`);
    }

    throw new Error(
        `beflow: board for ${projectKey} has drifted — missing ${parts.join("; ")} (present states: ${board.states.join(", ")}). Run \`beflow update ${projectKey}\` to reconcile.`,
    );
}
