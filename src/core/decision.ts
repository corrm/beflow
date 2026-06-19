export const NEEDS_DECISION_LABEL = "needs-decision";

export const DECISION_HOLD_MESSAGE =
    "This work item is held for a human decision (it carries the `needs-decision` label). Make the call and REMOVE the `needs-decision` label — beflow will then release it back to Todo and proceed. (Leave the rationale as a comment if useful.)";

export function isDecisionHeld(labels: string[]): boolean {
    return labels.includes(NEEDS_DECISION_LABEL);
}
