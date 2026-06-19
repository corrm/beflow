import { describe, expect, it } from "bun:test";

import { fromLinearStateType, toLinearStateType } from "../src/trackers/linear/client.ts";

describe("fromLinearStateType — read boundary: Linear SDK → beflow", () => {
    it("maps Linear 'canceled' (one L) to beflow 'cancelled' (two L's)", () => {
        expect(fromLinearStateType("canceled")).toBe("cancelled");
    });

    it("passes all other state types through unchanged", () => {
        for (const t of ["backlog", "unstarted", "started", "completed", "triage"] as const) {
            expect(fromLinearStateType(t)).toBe(t);
        }
    });

    it("passes 'cancelled' (beflow spelling) through unchanged", () => {
        expect(fromLinearStateType("cancelled")).toBe("cancelled");
    });
});

describe("toLinearStateType — write boundary: beflow → Linear SDK", () => {
    it("maps beflow 'cancelled' (two L's) to Linear 'canceled' (one L)", () => {
        expect(toLinearStateType("cancelled")).toBe("canceled");
    });

    it("passes all other state types through unchanged", () => {
        for (const t of ["backlog", "unstarted", "started", "completed", "triage"] as const) {
            expect(toLinearStateType(t)).toBe(t);
        }
    });

    it("passes 'canceled' (Linear spelling) through unchanged", () => {
        expect(toLinearStateType("canceled")).toBe("canceled");
    });
});
