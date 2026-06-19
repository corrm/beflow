import { describe, expect, it } from "bun:test";

import { parseIssueMeta } from "../src/resolve/metadata.ts";

describe("parseIssueMeta", () => {
    it("empty input -> empty meta", () => {
        expect(parseIssueMeta("", [])).toEqual({});
    });

    it("parses a body block", () => {
        const body = `Some text
<!-- beflow
agent: opencode
repo: api
runMode: autonomous
jobKind: implement
-->
more text`;
        expect(parseIssueMeta(body, [])).toEqual({
            agent: "opencode",
            jobKind: "implement",
            repo: "api",
            runMode: "autonomous",
        });
    });

    it("tolerates extra whitespace in body block", () => {
        const body = "<!--   beflow\n   agent :   pi   \n  run Mode ignored\n-->";
        expect(parseIssueMeta(body, []).agent).toBe("pi");
    });

    it("parses labels (run: prefix for runMode)", () => {
        expect(parseIssueMeta("", ["agent:opencode", "run:autonomous", "jobkind:spec"])).toEqual({
            agent: "opencode",
            jobKind: "spec",
            runMode: "autonomous",
        });
    });

    it("body block wins over label", () => {
        const body = "<!-- beflow\nagent: claude\n-->";
        const meta = parseIssueMeta(body, ["agent:opencode", "run:autonomous"]);
        expect(meta.agent).toBe("claude");
        expect(meta.runMode).toBe("autonomous");
    });

    it("ignores unknown keys in body block", () => {
        const body = "<!-- beflow\nagent: claude\nfoo: bar\npriority: high\n-->";
        expect(parseIssueMeta(body, [])).toEqual({ agent: "claude" });
    });

    it("rejects invalid runMode in body block (not silently accepted)", () => {
        const body = "<!-- beflow\nrunMode: attended\n-->";
        expect(parseIssueMeta(body, []).runMode).toBeUndefined();
    });

    it("rejects invalid jobKind in body block", () => {
        const body = "<!-- beflow\njobKind: bogus\n-->";
        expect(parseIssueMeta(body, []).jobKind).toBeUndefined();
    });

    it("rejects invalid runMode in label", () => {
        expect(parseIssueMeta("", ["run:attended"]).runMode).toBeUndefined();
    });

    it("rejects invalid jobKind in label", () => {
        expect(parseIssueMeta("", ["jobkind:bogus"]).jobKind).toBeUndefined();
    });

    it("non-beflow comments are ignored", () => {
        expect(parseIssueMeta("<!-- agent: x -->", [])).toEqual({});
    });
});
