import { describe, expect, it } from "bun:test";

import { buildAdvisorTask, extractVerdict, reviewWork } from "../src/agent/advisor.ts";
import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";

function verdictText(severity: string, note: string): string {
    return `Some reasoning here.\n\n\`\`\`beflow-advisor\n${JSON.stringify({ note, severity })}\n\`\`\`\n`;
}

describe("extractVerdict", () => {
    it("parses a well-formed verdict block", () => {
        expect(extractVerdict(verdictText("concern", "missed the criteria"))).toEqual({
            note: "missed the criteria",
            severity: "concern",
        });
    });

    it("takes the LAST block when several are present", () => {
        const text = verdictText("aside", "first") + verdictText("blocker", "last");
        expect(extractVerdict(text)?.severity).toBe("blocker");
    });

    it("returns null on no block, invalid JSON, or an unknown severity", () => {
        expect(extractVerdict("no block here")).toBeNull();
        expect(extractVerdict("```beflow-advisor\nnot json\n```")).toBeNull();
        expect(extractVerdict('```beflow-advisor\n{"severity":"meh","note":"x"}\n```')).toBeNull();
    });
});

describe("reviewWork", () => {
    function fakeDriver(assistantText: string): { driver: AgentDriver; seen: RunOptions[] } {
        const seen: RunOptions[] = [];
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async (opts: RunOptions): Promise<AgentRunResult> => {
                seen.push(opts);
                return {
                    exitCode: 0,
                    raw: [],
                    report: null,
                    stream: { assistantText, toolCalls: [] },
                    timedOut: false,
                };
            },
        };
        return { driver, seen };
    }

    it("runs the deputy read-only on its own session and returns the parsed verdict", async () => {
        const { driver, seen } = fakeDriver(verdictText("blocker", "unsafe change"));
        const verdict = await reviewWork({
            acpCommand: "claude",
            contract: "THE-CONTRACT",
            cwd: "/wt",
            diff: "THE-DIFF",
            driver,
            sessionKey: "CG-42-advisor",
        });

        expect(verdict).toEqual({ note: "unsafe change", severity: "blocker" });
        expect(seen[0]!.sessionKey).toBe("CG-42-advisor");
        // Read-only: supervised runMode maps to --approve-reads in the acpx driver.
        expect(seen[0]!.runMode).toBe("supervised");
        expect(seen[0]!.task).toBe(buildAdvisorTask("THE-CONTRACT", "THE-DIFF"));
    });

    it("returns null when the deputy emits no parseable verdict", async () => {
        const { driver } = fakeDriver("I forgot to emit a block.");
        expect(
            await reviewWork({
                acpCommand: "claude",
                contract: "c",
                cwd: "/wt",
                diff: "d",
                driver,
                sessionKey: "CG-42-advisor",
            }),
        ).toBeNull();
    });
});
