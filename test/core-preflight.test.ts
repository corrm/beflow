import { describe, expect, it } from "bun:test";

import { buildDecisionEvent } from "../src/core/decisionlog.ts";
import type { DecisionEvent } from "../src/core/decisionlog.ts";
import {
    derivePreflightPaths,
    findHistoricalOverlaps,
    formatHistoricalOverlap,
    PREFLIGHT_BLOCK_MESSAGE,
} from "../src/core/preflight.ts";
import type { PolicyDecision } from "../src/model/types.ts";

describe("derivePreflightPaths", () => {
    it("extracts confident path-like tokens from a body", () => {
        const body =
            "Update .github/workflows/ci.yml and add tests/x.test.ts plus src/core/run.ts to finish the change.";
        expect(derivePreflightPaths("", body)).toEqual([
            ".github/workflows/ci.yml",
            "tests/x.test.ts",
            "src/core/run.ts",
        ]);
    });

    it("also scans the title for paths", () => {
        expect(derivePreflightPaths("Fix infra/deploy.yaml", "no paths here")).toEqual(["infra/deploy.yaml"]);
    });

    it("ignores prose, URLs, and bare identifiers without a path separator", () => {
        const body =
            "See https://example.com/docs for context. Call computeChangedFiles and update the README to explain it.";
        expect(derivePreflightPaths("", body)).toEqual([]);
    });

    it("de-dupes repeated paths", () => {
        const body = "Touch src/app.ts then re-touch src/app.ts again.";
        expect(derivePreflightPaths("", body)).toEqual(["src/app.ts"]);
    });

    it("strips HTML tags before extracting (Plane bodies are HTML)", () => {
        const body = "<p>Edit <code>infra/secrets.tf</code> carefully.</p>";
        expect(derivePreflightPaths("", body)).toEqual(["infra/secrets.tf"]);
    });

    it("returns [] for a body with no paths", () => {
        expect(derivePreflightPaths("Crash on startup", "The app crashes when it boots.")).toEqual([]);
    });

    it("does not extract schemeless domain-like tokens as paths", () => {
        const body = "See example.com/index.html or www.foo.org/a/b.php for details. Fix src/core/run.ts.";
        const paths = derivePreflightPaths("", body);
        expect(paths).not.toContain("example.com/index.html");
        expect(paths).not.toContain("www.foo.org/a/b.php");
        expect(paths).toContain("src/core/run.ts");
    });

    it("exposes a stable block message", () => {
        expect(PREFLIGHT_BLOCK_MESSAGE).toContain("Needs Input");
        expect(PREFLIGHT_BLOCK_MESSAGE).toContain("policy");
    });
});

const fixedClock = (): string => "2026-06-20T00:00:00.000Z";

function event(key: string, decision: PolicyDecision, changedFiles: string[]): DecisionEvent {
    return buildDecisionEvent(
        { changedFiles, decision, evaluator: "globs", key, matchedRules: [], reason: "r", runId: `${key}@t` },
        fixedClock,
        () => `d-${key}`,
    );
}

describe("findHistoricalOverlaps", () => {
    it("returns a prior block event whose changed files overlap a derived path", () => {
        const events = [event("CG-7", "block", ["infra/secrets.tf", "src/a.ts"])];
        expect(findHistoricalOverlaps(events, ["infra/secrets.tf"])).toEqual([
            { decision: "block", key: "CG-7", paths: ["infra/secrets.tf"] },
        ]);
    });

    it("returns a prior require_approval event whose changed files overlap", () => {
        const events = [event("CG-8", "require_approval", ["src/core/run.ts"])];
        expect(findHistoricalOverlaps(events, ["src/core/run.ts"])).toEqual([
            { decision: "require_approval", key: "CG-8", paths: ["src/core/run.ts"] },
        ]);
    });

    it("ignores a prior allow event even when it overlaps", () => {
        const events = [event("CG-9", "allow", ["src/core/run.ts"])];
        expect(findHistoricalOverlaps(events, ["src/core/run.ts"])).toEqual([]);
    });

    it("returns [] when no changed files overlap the derived paths", () => {
        const events = [event("CG-7", "block", ["infra/secrets.tf"])];
        expect(findHistoricalOverlaps(events, ["src/core/run.ts"])).toEqual([]);
    });

    it("returns [] for empty events", () => {
        expect(findHistoricalOverlaps([], ["src/core/run.ts"])).toEqual([]);
    });

    it("only reports each overlapping path once (de-duped, order-preserving)", () => {
        const events = [event("CG-7", "block", ["src/a.ts", "src/b.ts", "src/a.ts"])];
        expect(findHistoricalOverlaps(events, ["src/a.ts", "src/b.ts"])).toEqual([
            { decision: "block", key: "CG-7", paths: ["src/a.ts", "src/b.ts"] },
        ]);
    });

    it("consults only the most-recent window: an overlap beyond the cap is ignored", () => {
        // Build > 1000 events: index 0 is the OLD overlap (pushed out of the 1000-event
        // Tail), then 1000 non-overlapping fillers, then a RECENT overlap at the end.
        const old = event("CG-1", "block", ["infra/old.tf"]);
        const fillers = Array.from({ length: 1000 }, (_, i) => event(`CG-f${String(i)}`, "block", ["unrelated.ts"]));
        const recent = event("CG-2", "block", ["infra/new.tf"]);
        const overlaps = findHistoricalOverlaps([old, ...fillers, recent], ["infra/old.tf", "infra/new.tf"]);
        expect(overlaps).toEqual([{ decision: "block", key: "CG-2", paths: ["infra/new.tf"] }]);
    });
});

describe("formatHistoricalOverlap", () => {
    it("renders an advisory line naming the prior key, decision, and overlapping paths", () => {
        const line = formatHistoricalOverlap(
            { decision: "block", key: "CG-7", paths: ["infra/secrets.tf", "src/a.ts"] },
            "CG-42",
        );
        expect(line).toContain("CG-42");
        expect(line).toContain("heads up");
        expect(line).toContain("block");
        expect(line).toContain("CG-7: infra/secrets.tf, src/a.ts");
        expect(line).toContain("the live policy gate remains authoritative");
    });
});
