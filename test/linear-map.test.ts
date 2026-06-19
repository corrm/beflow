import { describe, expect, it } from "bun:test";

import { mapIntakeItem, mapIssue, mapPriority, mapStateType, priorityRank } from "../src/trackers/linear/map.ts";
import type { RawIssue } from "../src/trackers/linear/types.ts";

function raw(overrides: Partial<RawIssue> = {}): RawIssue {
    return {
        description: "body text",
        id: "iss-1",
        identifier: "ENG-42",
        labels: [
            { id: "l1", name: "agent:claude" },
            { id: "l2", name: "bug" },
        ],
        priority: 2,
        state: { id: "s1", name: "Todo", type: "unstarted" },
        team: { id: "t1", key: "ENG" },
        title: "Fix crash",
        ...overrides,
    };
}

describe("mapPriority", () => {
    it("maps every numeric priority", () => {
        expect(mapPriority(1)).toBe("urgent");
        expect(mapPriority(2)).toBe("high");
        expect(mapPriority(3)).toBe("medium");
        expect(mapPriority(4)).toBe("low");
        expect(mapPriority(0)).toBe("none");
    });

    it("returns undefined for undefined", () => {
        expect(mapPriority(undefined)).toBeUndefined();
    });
});

describe("priorityRank", () => {
    it("ranks urgent→none ascending and sorts correctly", () => {
        const input = ["low", undefined, "urgent", "medium", "high"];
        const sorted = [...input].sort((a, b) => priorityRank(a) - priorityRank(b));
        expect(sorted).toEqual(["urgent", "high", "medium", "low", undefined]);
    });
});

describe("mapStateType", () => {
    it("passes through the 5 valid types", () => {
        for (const t of ["backlog", "unstarted", "started", "completed", "cancelled"] as const) {
            expect(mapStateType(t)).toBe(t);
        }
    });

    it("throws on triage", () => {
        expect(() => mapStateType("triage")).toThrow(/triage/);
    });

    it("throws on garbage", () => {
        expect(() => mapStateType("frobnicate")).toThrow(/unsupported state type/);
    });
});

describe("mapIssue", () => {
    it("normalizes a Linear issue", () => {
        const issue = mapIssue(raw());
        expect(issue.id).toBe("iss-1");
        expect(issue.key).toBe("ENG-42");
        expect(issue.title).toBe("Fix crash");
        expect(issue.body).toBe("body text");
        expect(issue.state).toEqual({ group: "unstarted", name: "Todo" });
        expect(issue.labels).toEqual(["agent:claude", "bug"]);
        expect(issue.priority).toBe("high");
    });

    it("sets areas to the same label-name list", () => {
        const issue = mapIssue(raw());
        expect(issue.areas).toEqual(issue.labels);
        expect(issue.areas).toEqual(["agent:claude", "bug"]);
    });

    it("leaves type undefined (Linear has no native type)", () => {
        expect(mapIssue(raw()).type).toBeUndefined();
    });

    it("defaults body to empty string when description undefined", () => {
        expect(mapIssue(raw({ description: undefined })).body).toBe("");
    });

    it("parses meta from body and labels", () => {
        const issue = mapIssue(
            raw({
                description: "<!-- beflow\njobKind: implement\n-->",
                labels: [{ id: "l", name: "agent:opencode" }],
            }),
        );
        expect(issue.meta).toEqual({ agent: "opencode", jobKind: "implement" });
    });

    it("throws when the state type is triage", () => {
        expect(() => mapIssue(raw({ state: { id: "s", name: "Triage", type: "triage" } }))).toThrow(/triage/);
    });
});

describe("mapIntakeItem", () => {
    it("maps a triage issue to an IntakeItem", () => {
        const item = mapIntakeItem(raw({ id: "iss-9", priority: 4 }));
        expect(item).toEqual({
            body: "body text",
            id: "iss-9",
            issueId: "iss-9",
            priority: "low",
            status: 0,
            title: "Fix crash",
        });
    });
});
