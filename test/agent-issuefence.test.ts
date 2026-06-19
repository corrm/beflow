import { describe, expect, it } from "bun:test";

import { extractIssueFence } from "../src/agent/issuefence.ts";

describe("extractIssueFence", () => {
    it("parses a valid beflow-issue block", () => {
        const text = [
            "Here is the issue.",
            "```beflow-issue",
            JSON.stringify({
                body: "## Summary\nlogin breaks",
                labels: ["regression"],
                priority: "high",
                title: "[bug] login",
                type: "Bug",
            }),
            "```",
        ].join("\n");
        expect(extractIssueFence(text)).toEqual({
            body: "## Summary\nlogin breaks",
            labels: ["regression"],
            priority: "high",
            title: "[bug] login",
            type: "Bug",
        });
    });

    it("tolerates CRLF line endings and trailing whitespace after info string", () => {
        const text = '```beflow-issue  \r\n{"body":"b"}\r\n```';
        expect(extractIssueFence(text)).toEqual({ body: "b" });
    });

    it("uses the LAST block when several exist", () => {
        const text = [
            "```beflow-issue",
            '{"body":"first"}',
            "```",
            "reconsidering...",
            "```beflow-issue",
            '{"body":"second"}',
            "```",
        ].join("\n");
        expect(extractIssueFence(text)).toEqual({ body: "second" });
    });

    it("returns null when no block is present", () => {
        expect(extractIssueFence("just prose, no issue block here")).toBeNull();
    });

    it("returns null on invalid JSON inside the block", () => {
        expect(extractIssueFence("```beflow-issue\n{not valid json}\n```")).toBeNull();
    });

    it("returns null when body is missing (schema-invalid)", () => {
        expect(extractIssueFence('```beflow-issue\n{"title":"no body"}\n```')).toBeNull();
    });

    it("returns null on a bad priority value", () => {
        expect(extractIssueFence('```beflow-issue\n{"body":"b","priority":"weird"}\n```')).toBeNull();
    });
});
