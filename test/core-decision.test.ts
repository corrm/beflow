import { describe, expect, it } from "bun:test";

import { DECISION_HOLD_MESSAGE, isDecisionHeld, NEEDS_DECISION_LABEL } from "../src/core/decision.ts";

describe("decision", () => {
    it("exports the label and hold-message constants", () => {
        expect(NEEDS_DECISION_LABEL).toBe("needs-decision");
        expect(DECISION_HOLD_MESSAGE).toContain("needs-decision");
        expect(DECISION_HOLD_MESSAGE).toContain("REMOVE");
    });

    it("isDecisionHeld is true when the label is present", () => {
        expect(isDecisionHeld(["needs-decision"])).toBe(true);
        expect(isDecisionHeld(["blocked", "needs-decision", "triaged"])).toBe(true);
    });

    it("isDecisionHeld is false when the label is absent", () => {
        expect(isDecisionHeld([])).toBe(false);
        expect(isDecisionHeld(["blocked", "failed"])).toBe(false);
    });
});
