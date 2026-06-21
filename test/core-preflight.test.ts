import { describe, expect, it } from "bun:test";

import { derivePreflightPaths, PREFLIGHT_BLOCK_MESSAGE } from "../src/core/preflight.ts";

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
