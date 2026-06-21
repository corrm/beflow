import { describe, expect, it } from "bun:test";

import {
    keyOf,
    mapIntakeItem,
    mapStateGroup,
    mapWorkItem,
    pickActiveCycle,
    priorityRank,
    toCommentHtml,
    unescapeHtml,
} from "../src/trackers/plane/map.ts";
import type { MapContext } from "../src/trackers/plane/map.ts";
import type {
    RawCycle,
    RawIntakeIssue,
    RawLabel,
    RawModule,
    RawState,
    RawWorkItem,
    RawWorkItemType,
} from "../src/trackers/plane/types.ts";

function ctx(overrides: Partial<MapContext> = {}): MapContext {
    return {
        identifier: "CG",
        labelsById: new Map<string, RawLabel>(),
        modulesById: new Map<string, RawModule>(),
        statesById: new Map<string, RawState>(),
        typesById: new Map<string, RawWorkItemType>(),
        ...overrides,
    };
}

describe("priorityRank", () => {
    it("ranks urgent→none ascending", () => {
        expect(priorityRank("urgent")).toBe(0);
        expect(priorityRank("high")).toBe(1);
        expect(priorityRank("medium")).toBe(2);
        expect(priorityRank("low")).toBe(3);
        expect(priorityRank("none")).toBe(4);
    });

    it("undefined and unknown both rank as 4", () => {
        expect(priorityRank(undefined)).toBe(4);
        expect(priorityRank("bogus")).toBe(4);
    });

    it("produces a correctly ordered sort", () => {
        const input = ["low", undefined, "urgent", "medium", "high"];
        const sorted = [...input].sort((a, b) => priorityRank(a) - priorityRank(b));
        expect(sorted).toEqual(["urgent", "high", "medium", "low", undefined]);
    });
});

describe("mapStateGroup", () => {
    it("passes through the 5 valid groups", () => {
        for (const g of ["backlog", "unstarted", "started", "completed", "cancelled"] as const) {
            expect(mapStateGroup(g)).toBe(g);
        }
    });

    it("throws on triage", () => {
        expect(() => mapStateGroup("triage")).toThrow(/triage/);
    });

    it("throws on garbage", () => {
        expect(() => mapStateGroup("frobnicate")).toThrow(/unsupported state group/);
    });
});

describe("toCommentHtml", () => {
    it("escapes HTML special chars", () => {
        expect(toCommentHtml("a & b < c > d")).toBe("<p>a &amp; b &lt; c &gt; d</p>");
    });

    it("splits blank-line-separated paragraphs", () => {
        expect(toCommentHtml("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
    });

    it("turns single newlines into <br>", () => {
        expect(toCommentHtml("line1\nline2")).toBe("<p>line1<br>line2</p>");
    });

    it("handles paragraphs and breaks together", () => {
        expect(toCommentHtml("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>");
    });

    it("escaping happens before tag wrapping", () => {
        expect(toCommentHtml("<script>")).toBe("<p>&lt;script&gt;</p>");
    });
});

describe("unescapeHtml", () => {
    it("decodes &lt; &gt; &amp;", () => {
        expect(unescapeHtml("a &amp; b &lt; c &gt; d")).toBe("a & b < c > d");
    });

    it("is the exact inverse of escapeHtml (round-trip identity)", () => {
        const inputs = ["a & b < c > d", "plain text", "<already> &escaped&", "&&amp;"];
        for (const s of inputs) {
            expect(unescapeHtml(toCommentHtml(s).replace(/<[^>]*>/g, ""))).toBe(s);
        }
    });

    it("decodes &amp; last so &amp;lt; round-trips to &lt; not <", () => {
        expect(unescapeHtml("&amp;lt;")).toBe("&lt;");
    });

    it("leaves plain text unchanged", () => {
        expect(unescapeHtml("hello world")).toBe("hello world");
    });
});

describe("keyOf", () => {
    it("joins identifier and sequence", () => {
        expect(keyOf("CG", 42)).toBe("CG-42");
    });
});

describe("mapWorkItem", () => {
    it("maps an expanded work item (state + labels objects)", () => {
        const raw: RawWorkItem = {
            description_html: "<p>body text</p>",
            description_stripped: "body text",
            id: "wi-1",
            labels: [
                { id: "l1", name: "agent:claude" },
                { id: "l2", name: "bug" },
            ],
            name: "Fix crash",
            priority: "high",
            sequence_id: 42,
            state: { color: "#fff", group: "unstarted", id: "s1", name: "Todo" },
        };
        const issue = mapWorkItem(raw, ctx());
        expect(issue.id).toBe("wi-1");
        expect(issue.key).toBe("CG-42");
        expect(issue.title).toBe("Fix crash");
        expect(issue.body).toBe("body text");
        expect(issue.state).toEqual({ group: "unstarted", name: "Todo" });
        expect(issue.labels).toEqual(["agent:claude", "bug"]);
        expect(issue.priority).toBe("high");
    });

    it("carries parentId when the raw work item has a parent uuid", () => {
        const raw: RawWorkItem = {
            description_stripped: "child",
            id: "wi-1",
            name: "Child",
            parent: "wi-epic",
            sequence_id: 7,
            state: { color: "#fff", group: "unstarted", id: "s1", name: "Todo" },
        };
        expect(mapWorkItem(raw, ctx()).parentId).toBe("wi-epic");
    });

    it("leaves parentId undefined when parent is null or absent", () => {
        const base: RawWorkItem = {
            description_stripped: "x",
            id: "wi-1",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s1", name: "Todo" },
        };
        expect(mapWorkItem(base, ctx()).parentId).toBeUndefined();
        expect(mapWorkItem({ ...base, parent: null }, ctx()).parentId).toBeUndefined();
    });

    it("does not use description_html for body", () => {
        const raw: RawWorkItem = {
            description_html: "<p>html</p>",
            id: "wi-1",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s1", name: "Todo" },
        };
        expect(mapWorkItem(raw, ctx()).body).toBe("");
    });

    it("resolves uuid-only state and labels via maps", () => {
        const raw: RawWorkItem = {
            id: "wi-2",
            labels: ["l1"],
            name: "Task",
            sequence_id: 7,
            state: "s1",
        };
        const c = ctx({
            labelsById: new Map([["l1", { id: "l1", name: "feature" }]]),
            statesById: new Map([["s1", { id: "s1", name: "In Progress", group: "started", color: "#0f0" }]]),
        });
        const issue = mapWorkItem(raw, c);
        expect(issue.state).toEqual({ group: "started", name: "In Progress" });
        expect(issue.labels).toEqual(["feature"]);
    });

    it("resolves the type UUID to its name via the types cache", () => {
        // Regression: Plane returns the type as a UUID; a bare UUID would break
        // JobKind auto-detect (Spike→triage). Caught live against real Plane.
        const raw: RawWorkItem = {
            id: "wi",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
            type: "ty-spike",
        };
        const c = ctx({
            typesById: new Map([["ty-spike", { id: "ty-spike", name: "Spike" }]]),
        });
        expect(mapWorkItem(raw, c).type).toBe("Spike");
    });

    it("maps type from type_id when type is absent, undefined when unknown", () => {
        const base = {
            id: "wi",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        } as const;
        const c = ctx({ typesById: new Map([["ty-bug", { id: "ty-bug", name: "Bug" }]]) });
        expect(mapWorkItem({ ...base, type_id: "ty-bug" }, c).type).toBe("Bug");
        expect(mapWorkItem({ ...base, type: "ty-unknown" }, c).type).toBeUndefined();
    });

    it("does not throw and yields type undefined when type and type_id are both null", () => {
        // Regression: a project with issue-types DISABLED returns work items with
        // `type: null` and `type_id: null` (caught live 2026-06-18). The old guard only
        // checked `=== undefined`, so `typeof null === "object"` reached `type.name` and
        // threw a TypeError, crashing getIssue for every work item on a typeless project.
        const raw: RawWorkItem = {
            id: "wi",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
            type: null,
            type_id: null,
        };
        let issue: ReturnType<typeof mapWorkItem> | undefined;
        expect(() => {
            issue = mapWorkItem(raw, ctx());
        }).not.toThrow();
        expect(issue!.type).toBeUndefined();
    });

    it("throws when state uuid is unresolvable", () => {
        const raw: RawWorkItem = { id: "wi", name: "x", sequence_id: 1, state: "missing" };
        expect(() => mapWorkItem(raw, ctx())).toThrow(/cannot resolve state uuid/);
    });

    it("throws when label uuid is unresolvable", () => {
        const raw: RawWorkItem = {
            id: "wi",
            labels: ["missing"],
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        expect(() => mapWorkItem(raw, ctx())).toThrow(/cannot resolve label uuid/);
    });

    it("throws when work item has no state", () => {
        const raw: RawWorkItem = { id: "wi", name: "x", sequence_id: 1 };
        expect(() => mapWorkItem(raw, ctx())).toThrow(/has no state/);
    });

    it("maps areas from module_ids", () => {
        const raw: RawWorkItem = {
            id: "wi",
            module_ids: ["m1", "m2"],
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        const c = ctx({
            modulesById: new Map([
                ["m1", { id: "m1", name: "GUI" }],
                ["m2", { id: "m2", name: "Website" }],
            ]),
        });
        expect(mapWorkItem(raw, c).areas).toEqual(["GUI", "Website"]);
    });

    it("areas is [] when module_ids absent", () => {
        const raw: RawWorkItem = {
            id: "wi",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        expect(mapWorkItem(raw, ctx()).areas).toEqual([]);
    });

    it("throws on unresolvable module id", () => {
        const raw: RawWorkItem = {
            id: "wi",
            module_ids: ["missing"],
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        expect(() => mapWorkItem(raw, ctx())).toThrow(/cannot resolve module uuid/);
    });

    it("maps type from a uuid (via cache), an expanded object, or undefined", () => {
        const base: RawWorkItem = {
            id: "wi",
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        const c = ctx({ typesById: new Map([["t1", { id: "t1", name: "Bug" }]]) });
        expect(mapWorkItem({ ...base, type: "t1" }, c).type).toBe("Bug");
        expect(mapWorkItem({ ...base, type: { id: "t1", name: "Feature" } }, ctx()).type).toBe("Feature");
        expect(mapWorkItem(base, ctx()).type).toBeUndefined();
    });

    it("reuses parseIssueMeta over body + labels", () => {
        const raw: RawWorkItem = {
            description_stripped: "<!-- beflow\njobKind: implement\n-->",
            id: "wi",
            labels: [{ id: "l", name: "agent:opencode" }],
            name: "x",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s", name: "Todo" },
        };
        const issue = mapWorkItem(raw, ctx());
        expect(issue.meta).toEqual({ agent: "opencode", jobKind: "implement" });
    });
});

describe("mapIntakeItem", () => {
    it("maps the live Plane intake shape (issue=uuid, issue_detail=object)", () => {
        const raw: RawIntakeIssue = {
            id: "intake-1",
            issue: "858fb978-ab78-41f4-a035-d2e46b257777",
            issue_detail: {
                description_stripped: "Body",
                id: "858fb978-ab78-41f4-a035-d2e46b257777",
                name: "Title",
                priority: "high",
                sequence_id: 5,
            },
            status: -2,
        };
        expect(mapIntakeItem(raw)).toEqual({
            body: "Body",
            id: "intake-1",
            issueId: "858fb978-ab78-41f4-a035-d2e46b257777",
            priority: "high",
            status: -2,
            title: "Title",
        });
    });

    it("prefers description_stripped, falls back to description, then empty string", () => {
        const base: RawIntakeIssue = {
            id: "in-2",
            issue: "wi-uuid",
            issue_detail: { description: "desc", description_stripped: "stripped", id: "wi-uuid", name: "n" },
            status: 1,
        };
        expect(mapIntakeItem(base).body).toBe("stripped");

        const descOnly: RawIntakeIssue = {
            id: "in-3",
            issue: "wi-uuid",
            issue_detail: { description: "desc", id: "wi-uuid", name: "n" },
            status: 1,
        };
        expect(mapIntakeItem(descOnly).body).toBe("desc");

        const noBody: RawIntakeIssue = {
            id: "in-4",
            issue: "wi-uuid",
            issue_detail: { id: "wi-uuid", name: "n" },
            status: 1,
        };
        expect(mapIntakeItem(noBody).body).toBe("");
    });
});

describe("pickActiveCycle", () => {
    function cycle(over: Partial<RawCycle> & { id: string }): RawCycle {
        return { name: "Sprint", ...over };
    }

    it("returns a cycle whose range contains today", () => {
        const cycles = [cycle({ end_date: "2026-06-30", id: "c1", start_date: "2026-06-01" })];
        expect(pickActiveCycle(cycles, "2026-06-16")?.id).toBe("c1");
    });

    it("includes the boundary dates (inclusive start and end)", () => {
        const cycles = [cycle({ end_date: "2026-06-30", id: "c1", start_date: "2026-06-01" })];
        expect(pickActiveCycle(cycles, "2026-06-01")?.id).toBe("c1");
        expect(pickActiveCycle(cycles, "2026-06-30")?.id).toBe("c1");
    });

    it("returns null when today is out of range", () => {
        const cycles = [cycle({ end_date: "2026-06-30", id: "c1", start_date: "2026-06-01" })];
        expect(pickActiveCycle(cycles, "2026-07-01")).toBeNull();
        expect(pickActiveCycle(cycles, "2026-05-31")).toBeNull();
    });

    it("skips cycles missing a start or end date", () => {
        const cycles = [
            cycle({ end_date: "2026-06-30", id: "no-start" }),
            cycle({ id: "no-end", start_date: "2026-06-01" }),
            cycle({ end_date: null, id: "null-end", start_date: "2026-06-01" }),
        ];
        expect(pickActiveCycle(cycles, "2026-06-16")).toBeNull();
    });

    it("picks the first matching cycle when several are active", () => {
        const cycles = [
            cycle({ end_date: "2026-06-30", id: "first", start_date: "2026-06-01" }),
            cycle({ end_date: "2026-07-31", id: "second", start_date: "2026-06-10" }),
        ];
        expect(pickActiveCycle(cycles, "2026-06-16")?.id).toBe("first");
    });

    it("returns null for an empty cycle list", () => {
        expect(pickActiveCycle([], "2026-06-16")).toBeNull();
    });
});
