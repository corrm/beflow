import type { IntakeItem, Tracker } from "../trackers/tracker.ts";
import type { Logger } from "./run.ts";

export interface AcceptDeps {
    tracker: Tracker;
    log?: Logger;
}

export async function acceptIntake(projectKey: string, intakeId: string, deps: AcceptDeps): Promise<IntakeItem> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    const inbox = await deps.tracker.listInbox(projectKey);
    const item = inbox.find((i) => i.id === intakeId);
    if (item === undefined) {
        const available = inbox.map((i) => i.id).join(", ");
        throw new Error(`beflow: unknown intake id "${intakeId}" in ${projectKey} (available: ${available})`);
    }

    await deps.tracker.acceptInbox(projectKey, item);
    log(`beflow: accepted intake ${intakeId} ("${item.title}") in ${projectKey}`);
    return item;
}
