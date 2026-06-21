import { describe, expect, it } from "bun:test";

import { collectNodes, fromLinearStateType, toLinearStateType } from "../src/trackers/linear/client.ts";
import type { SdkConnection } from "../src/trackers/linear/client.ts";

// A multi-page SDK connection backed by an array of pages. Each page exposes its
// Own nodes plus hasNextPage; fetchNext() advances to the next page, mirroring the
// @linear/sdk Connection contract (nodes / pageInfo.hasNextPage / fetchNext) that
// collectNodes walks. getBlockers/listComments/listStates/listLabels/listAttachments
// All funnel their first connection page through collectNodes.
function pagedConnection<T>(pages: T[][], cursor = 0): SdkConnection<T> {
    return {
        fetchNext: async () => pagedConnection(pages, cursor + 1),
        nodes: pages[cursor] ?? [],
        pageInfo: { hasNextPage: cursor < pages.length - 1 },
    };
}

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

describe("collectNodes — pagination: the gateway must walk every connection page", () => {
    it("accumulates nodes across multiple pages in order", async () => {
        const conn = pagedConnection([["a", "b"], ["c", "d"], ["e"]]);
        expect(await collectNodes(conn)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("returns the single page when there is no next page", async () => {
        const conn = pagedConnection([["only"]]);
        expect(await collectNodes(conn)).toEqual(["only"]);
    });

    it("does not truncate at the SDK's default first page (50+ blockers stay visible)", async () => {
        const firstPage = Array.from({ length: 50 }, (_, i) => `blocker-${String(i)}`);
        const secondPage = ["blocker-50"];
        const all = await collectNodes(pagedConnection([firstPage, secondPage]));
        expect(all).toHaveLength(51);
        expect(all.at(-1)).toBe("blocker-50");
    });
});
