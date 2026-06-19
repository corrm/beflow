import { describe, expect, it } from "bun:test";

import { parseAcpLine, reduceAcpStream } from "../src/agent/events.ts";

const FIXTURE = [
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":"toolu_01","sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute","content":[]}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"toolCallId":"toolu_01","sessionUpdate":"tool_call_update","status":"completed","rawOutput":"hello-tool","content":[{"type":"content","content":{"type":"text","text":"```console\\nhello-tool\\n```"}}]}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"O"}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"K"}}}}',
    '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn","usage":{"inputTokens":7,"outputTokens":102}}}',
];

describe("parseAcpLine", () => {
    it("parses a JSON line", () => {
        expect(parseAcpLine('{"a":1}')).toEqual({ a: 1 });
    });

    it("trims whitespace before parsing", () => {
        expect(parseAcpLine('   {"a":1}  ')).toEqual({ a: 1 });
    });

    it("returns null for blank lines", () => {
        expect(parseAcpLine("")).toBeNull();
        expect(parseAcpLine("   ")).toBeNull();
    });

    it("returns null for garbage", () => {
        expect(parseAcpLine("not json")).toBeNull();
    });
});

describe("reduceAcpStream", () => {
    it("rebuilds assistant text, tool call, and stop reason from real fixture", () => {
        const result = reduceAcpStream(FIXTURE);
        expect(result.assistantText).toBe("OK");
        expect(result.toolCalls).toEqual([
            {
                id: "toolu_01",
                kind: "execute",
                status: "completed",
                title: "Terminal",
                toolName: "Bash",
            },
        ]);
        expect(result.stopReason).toBe("end_turn");
        expect(result.error).toBeUndefined();
    });

    it("calls onEvent for every non-null line", () => {
        const seen: unknown[] = [];
        reduceAcpStream([...FIXTURE, "", "garbage"], (e) => {
            seen.push(e);
        });
        expect(seen).toHaveLength(FIXTURE.length);
    });

    it("skips blank and garbage lines", () => {
        const result = reduceAcpStream(["", "   ", "not json", ...FIXTURE]);
        expect(result.assistantText).toBe("OK");
    });

    it("ignores agent_thought_chunk", () => {
        const lines = [
            '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}}}',
            '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}',
        ];
        const result = reduceAcpStream(lines);
        expect(result.assistantText).toBe("hi");
    });

    it("captures an error response with code and message", () => {
        const lines = ['{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"boom"}}'];
        const result = reduceAcpStream(lines);
        expect(result.error).toEqual({ code: -32000, message: "boom" });
    });

    it("pushes a tool_call_update with no prior tool_call", () => {
        const lines = [
            '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"toolCallId":"x","sessionUpdate":"tool_call_update","status":"completed"}}}',
        ];
        const result = reduceAcpStream(lines);
        expect(result.toolCalls).toEqual([{ id: "x", status: "completed", title: undefined, toolName: undefined }]);
    });
});

function usageLine(usage: Record<string, unknown>): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "usage_update", usage } },
    });
}

function usageLineFlat(fields: Record<string, unknown>): string {
    return JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "usage_update", ...fields } },
    });
}

describe("reduceAcpStream usage_update", () => {
    it("reads camelCase token counts from a nested usage object", () => {
        const result = reduceAcpStream([usageLine({ inputTokens: 100, outputTokens: 40, totalTokens: 140 })]);
        expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    });

    it("reads snake_case token counts", () => {
        const result = reduceAcpStream([
            usageLine({ cache_read_tokens: 12, input_tokens: 100, output_tokens: 40, total_tokens: 140 }),
        ]);
        expect(result.usage).toEqual({
            cacheReadTokens: 12,
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
        });
    });

    it("reads token counts from the top-level update when there is no nested usage", () => {
        const result = reduceAcpStream([usageLineFlat({ inputTokens: 7, outputTokens: 3 })]);
        expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    });

    it("captures a cost figure when the event reports one", () => {
        const result = reduceAcpStream([usageLine({ cost: 0.0123, totalTokens: 200 })]);
        expect(result.usage).toEqual({ costUsd: 0.0123, totalTokens: 200 });
    });

    it("merges across multiple usage_update events (last-wins per field)", () => {
        const result = reduceAcpStream([
            usageLine({ inputTokens: 10, outputTokens: 5 }),
            usageLine({ outputTokens: 50, totalTokens: 60 }),
        ]);
        expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 50, totalTokens: 60 });
    });

    it("leaves garbage/non-numeric fields undefined and never throws", () => {
        const result = reduceAcpStream([usageLine({ inputTokens: "NaN", outputTokens: null, totalTokens: {} })]);
        expect(result.usage).toBeUndefined();
    });

    it("coerces numeric strings", () => {
        const result = reduceAcpStream([usageLine({ totalTokens: "140" })]);
        expect(result.usage).toEqual({ totalTokens: 140 });
    });

    it("leaves usage undefined when no usage_update is present and result carries none", () => {
        const lines = [
            '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}',
            '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
        ];
        const result = reduceAcpStream(lines);
        expect(result.usage).toBeUndefined();
    });

    it("reads `used` as totalTokens from a streaming usage_update (real wire shape)", () => {
        const result = reduceAcpStream([usageLineFlat({ used: 25939, size: 200000 })]);
        expect(result.usage).toEqual({ totalTokens: 25939 });
    });

    it("reads cost.amount from a streaming usage_update when cost is an object", () => {
        const result = reduceAcpStream([
            usageLineFlat({ used: 25939, size: 1000000, cost: { amount: 0.08546, currency: "USD" } }),
        ]);
        expect(result.usage).toEqual({ costUsd: 0.08546, totalTokens: 25939 });
    });

    it("parses final result.usage with real camelCase field names", () => {
        const line =
            '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":8064,"outputTokens":5,"cachedReadTokens":14072,"cachedWriteTokens":3798,"totalTokens":25939}}}';
        const result = reduceAcpStream([line]);
        expect(result.stopReason).toBe("end_turn");
        expect(result.usage).toEqual({
            cacheReadTokens: 14072,
            cacheWriteTokens: 3798,
            inputTokens: 8064,
            outputTokens: 5,
            totalTokens: 25939,
        });
    });

    it("merges streaming cost with final result.usage token breakdown", () => {
        const streamingCost = usageLineFlat({ used: 25939, size: 1000000, cost: { amount: 0.08546, currency: "USD" } });
        const finalResult =
            '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":{"inputTokens":8064,"outputTokens":5,"cachedReadTokens":14072,"cachedWriteTokens":3798,"totalTokens":25939}}}';
        const result = reduceAcpStream([streamingCost, finalResult]);
        expect(result.usage).toEqual({
            cacheReadTokens: 14072,
            cacheWriteTokens: 3798,
            costUsd: 0.08546,
            inputTokens: 8064,
            outputTokens: 5,
            totalTokens: 25939,
        });
    });
});
