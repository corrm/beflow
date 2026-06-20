import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import type { RunRecord } from "../src/core/runstore.ts";
import {
    formatRunDetail,
    formatRunList,
    formatTelemetryLine,
    resolveTelemetryInComment,
    totalTokensOf,
} from "../src/core/runsview.ts";

function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
    return {
        agent: "claude",
        cwd: "/wt/cg-42",
        jobKind: "implement",
        key: "CG-42",
        runMode: "autonomous",
        sessionName: "CG-42",
        status: "done",
        updatedAt: "2026-06-14T00:00:00.000Z",
        ...over,
    };
}

function makeConfig(over: Partial<Config> = {}): Config {
    return {
        agents: {},
        agent: "claude",
        onManualMove: "yield",
        runMode: "autonomous",
        tracker: "plane",
        trackers: {},
        ...over,
    };
}

function makeRegistry(telemetry?: { inComment?: boolean }): Registry {
    return {
        projects: {
            CG: {
                default_repo: "bin",
                module_repo_map: {},
                name: "My App",
                plane_project_id: "pid",
                repos: { bin: "/repo/bin" },
                root: "/root",
                ...(telemetry !== undefined ? { telemetry } : {}),
            },
        },
        workspace: { id: "w", slug: "your-workspace" },
    };
}

describe("totalTokensOf", () => {
    it("prefers an explicit total", () => {
        expect(totalTokensOf({ inputTokens: 10, outputTokens: 5, totalTokens: 99 })).toBe(99);
    });
    it("derives from input+output when total is absent", () => {
        expect(totalTokensOf({ inputTokens: 10, outputTokens: 5 })).toBe(15);
    });
    it("returns undefined when neither is derivable", () => {
        expect(totalTokensOf({ inputTokens: 10 })).toBeUndefined();
        expect(totalTokensOf({})).toBeUndefined();
    });
});

describe("resolveTelemetryInComment", () => {
    it("is false when neither layer opts in", () => {
        expect(resolveTelemetryInComment(makeConfig(), makeRegistry(), "CG")).toBe(false);
    });
    it("honors the default layer", () => {
        expect(resolveTelemetryInComment(makeConfig({ telemetry: { inComment: true } }), makeRegistry(), "CG")).toBe(
            true,
        );
    });
    it("project overrides the default", () => {
        const config = makeConfig({ telemetry: { inComment: true } });
        expect(resolveTelemetryInComment(config, makeRegistry({ inComment: false }), "CG")).toBe(false);
    });
});

describe("formatTelemetryLine", () => {
    it("formats tokens, model and attempt", () => {
        expect(formatTelemetryLine({ totalTokens: 140 }, "sonnet", 0)).toBe(
            "beflow: 140 tok · model sonnet · attempt 0",
        );
    });
    it("uses 'default' when no model and 'n' when no attempts", () => {
        expect(formatTelemetryLine({ totalTokens: 140 }, undefined, undefined)).toBe(
            "beflow: 140 tok · model default · attempt n",
        );
    });
    it("appends cost only when present", () => {
        expect(formatTelemetryLine({ costUsd: 0.0123, totalTokens: 200 }, "opus", 1)).toBe(
            "beflow: 200 tok · model opus · attempt 1 · ~$0.0123",
        );
    });
    it("omits the tok segment when no count is derivable but cost exists", () => {
        expect(formatTelemetryLine({ costUsd: 0.5 }, "opus", 0)).toBe("beflow: model opus · attempt 0 · ~$0.5000");
    });
    it("returns undefined when usage carries neither tokens nor cost", () => {
        expect(formatTelemetryLine({}, "opus", 0)).toBeUndefined();
        expect(formatTelemetryLine({ inputTokens: 10 }, "opus", 0)).toBeUndefined();
    });
    it("derives the token count from input+output", () => {
        expect(formatTelemetryLine({ inputTokens: 10, outputTokens: 5 }, "opus", 0)).toBe(
            "beflow: 15 tok · model opus · attempt 0",
        );
    });
});

describe("formatRunList", () => {
    it("reports an empty-store message", () => {
        expect(formatRunList([])).toEqual(["beflow: no run records"]);
    });
    it("emits one sorted compact line per record", () => {
        const lines = formatRunList([
            makeRecord({ attempts: 2, key: "CG-2", status: "failed", usage: { totalTokens: 50 } }),
            makeRecord({ key: "CG-1", status: "done" }),
        ]);
        expect(lines).toEqual(["CG-1  done  attempts=0  -", "CG-2  failed  attempts=2  50 tok"]);
    });
});

describe("formatRunDetail", () => {
    it("renders the core fields and resolved model", () => {
        const lines = formatRunDetail(makeRecord({ attempts: 1 }), "sonnet");
        expect(lines).toContain("key: CG-42");
        expect(lines).toContain("status: done");
        expect(lines).toContain("attempts: 1");
        expect(lines).toContain("agent: claude");
        expect(lines).toContain("model: sonnet");
        expect(lines).toContain("jobKind: implement");
        expect(lines).toContain("runMode: autonomous");
    });
    it("uses 'default' when no model resolves", () => {
        expect(formatRunDetail(makeRecord(), undefined)).toContain("model: default");
    });
    it("includes token, cost, prUrl and reviewedSha when present", () => {
        const lines = formatRunDetail(
            makeRecord({
                prUrl: "http://pr/1",
                reviewedSha: "deadbeef",
                usage: {
                    cacheReadTokens: 200,
                    cacheWriteTokens: 30,
                    costUsd: 0.05,
                    inputTokens: 100,
                    outputTokens: 40,
                    totalTokens: 140,
                },
            }),
            "opus",
        );
        expect(lines).toContain("tokens: 140");
        expect(lines).toContain("  input: 100");
        expect(lines).toContain("  output: 40");
        expect(lines).toContain("  cacheRead: 200");
        expect(lines).toContain("  cacheWrite: 30");
        expect(lines).toContain("cost: ~$0.0500");
        expect(lines).toContain("prUrl: http://pr/1");
        expect(lines).toContain("reviewedSha: deadbeef");
    });
    it("omits the usage block when no usage is present", () => {
        const lines = formatRunDetail(makeRecord(), "opus");
        expect(lines.some((l) => l.startsWith("tokens:"))).toBe(false);
        expect(lines.some((l) => l.startsWith("cost:"))).toBe(false);
    });
});
