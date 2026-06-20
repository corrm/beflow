import type { Config, Registry } from "../config/schema.ts";
import type { Issue } from "../model/types.ts";
import type { Tracker } from "../trackers/tracker.ts";
import { notifyEscalation } from "./notify.ts";
import type { Notifier } from "./notify.ts";
import type { Clock, RunRecord, RunStoreFs } from "./runstore.ts";
import { saveRecord } from "./runstore.ts";

export const QUARANTINED_LABEL = "quarantined";

const NEEDS_INPUT_STATE = "Needs Input";

const DEFAULT_MAX_ATTEMPTS = 3;

/** Universal failure cap: quarantine once the accumulated attempt count reaches the threshold. */
export function shouldQuarantine(attempts: number, threshold: number): boolean {
    return attempts >= threshold;
}

/** Project-over-default-over-3 resolution of the unified dead-letter threshold. */
export function resolveDeadLetterThreshold(config: Config, registry: Registry, projectKey: string): number {
    const projectMax = registry.projects[projectKey]?.deadLetter?.maxAttempts;
    const globalMax = config.deadLetter?.maxAttempts;
    return projectMax ?? globalMax ?? DEFAULT_MAX_ATTEMPTS;
}

export interface QuarantineDeps {
    clock: Clock;
    notify?: Notifier;
    record: RunRecord;
    runsDir: string;
    runsFs?: RunStoreFs;
    tracker: Tracker;
}

/**
 * Shared dead-letter: label the issue `quarantined`, park it in Needs Input, notify the
 * Escalation channel, and persist the run record as a quarantine hold. Degrade-safe — a
 * Tracker/notify failure must not throw out and halt the watch tick.
 */
export async function quarantine(issue: Issue, detail: string, deps: QuarantineDeps): Promise<void> {
    try {
        await deps.tracker.addProperty(issue, QUARANTINED_LABEL);
        await deps.tracker.updateState(issue, NEEDS_INPUT_STATE);
        await deps.tracker.comment(issue, detail);
        await notifyEscalation(deps.notify, issue, "failed", detail);
    } catch {
        // Best-effort escalation: a transient tracker/notify error must not crash the tick.
    }
    saveRecord(
        deps.runsDir,
        { ...deps.record, heldReason: "quarantine", status: "failed", updatedAt: deps.clock() },
        deps.runsFs,
    );
}
