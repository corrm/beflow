import type { JobKind, StateGroup } from "../model/types.ts";

export function autoDetectJobKind(type: string | undefined, stateGroup: StateGroup): JobKind {
    if (type === "Spike") {
        return "triage";
    }
    if (stateGroup === "backlog") {
        return "spec";
    }
    return "implement";
}
