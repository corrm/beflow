import { describe, expect, it } from "bun:test";

import { extractReport } from "../src/agent/report.ts";

describe("extractReport", () => {
    it("parses a valid beflow-report block", () => {
        const text = [
            "```beflow-report",
            JSON.stringify({ prUrl: "http://pr", status: "done", summary: "shipped it" }),
            "```",
        ].join("\n");
        expect(extractReport(text)).toEqual({
            prUrl: "http://pr",
            status: "done",
            summary: "shipped it",
        });
    });

    it("tolerates leading/trailing prose around the block", () => {
        const text = [
            "Here is my final answer.",
            "",
            "```beflow-report",
            '{"status":"blocked","summary":"need creds"}',
            "```",
            "",
            "Thanks!",
        ].join("\n");
        expect(extractReport(text)).toEqual({
            status: "blocked",
            summary: "need creds",
        });
    });

    it("uses the LAST block when several exist", () => {
        const text = [
            "```beflow-report",
            '{"status":"failed","summary":"first"}',
            "```",
            "reconsidering...",
            "```beflow-report",
            '{"status":"done","summary":"second"}',
            "```",
        ].join("\n");
        expect(extractReport(text)).toEqual({ status: "done", summary: "second" });
    });

    it("tolerates CRLF line endings and trailing whitespace after info string", () => {
        const text = '```beflow-report  \r\n{"status":"needs_input","summary":"q?"}\r\n```';
        expect(extractReport(text)).toEqual({
            status: "needs_input",
            summary: "q?",
        });
    });

    it("parses optional questions/notes", () => {
        const text = `\`\`\`beflow-report\n${JSON.stringify({
            status: "needs_input",
            summary: "s",
            questions: ["a", "b"],
            notes: "n",
        })}\n\`\`\``;
        expect(extractReport(text)).toEqual({
            notes: "n",
            questions: ["a", "b"],
            status: "needs_input",
            summary: "s",
        });
    });

    it("strips unknown extra keys (e.g. a stale nextState) rather than rejecting", () => {
        const text = `\`\`\`beflow-report\n${JSON.stringify({
            status: "done",
            summary: "s",
            nextState: "Review",
        })}\n\`\`\``;
        expect(extractReport(text)).toEqual({ status: "done", summary: "s" });
    });

    it("returns null when no block is present", () => {
        expect(extractReport("just some prose, no report here")).toBeNull();
    });

    it("does NOT fall back to a plain json block", () => {
        const text = '```json\n{"status":"done","summary":"x"}\n```';
        expect(extractReport(text)).toBeNull();
    });

    it("returns null on invalid JSON inside the block", () => {
        const text = "```beflow-report\n{not valid json}\n```";
        expect(extractReport(text)).toBeNull();
    });

    it("returns null on a bad status value", () => {
        const text = '```beflow-report\n{"status":"weird","summary":"x"}\n```';
        expect(extractReport(text)).toBeNull();
    });

    it("returns null when summary is missing", () => {
        const text = '```beflow-report\n{"status":"done"}\n```';
        expect(extractReport(text)).toBeNull();
    });
});
