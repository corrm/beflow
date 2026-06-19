import { describe, expect, it } from "bun:test";

import {
    AcpxDriver,
    buildAcpxArgs,
    buildCancelArgs,
    buildEnsureSessionArgs,
    resolveAcpCommand,
    resolveAcpxCommand,
} from "../src/agent/acpx.ts";
import type { ProcessRunner, SpawnedProcess } from "../src/agent/acpx.ts";
import type { RunOptions } from "../src/agent/driver.ts";
import type { Config } from "../src/config/schema.ts";

const baseConfig: Config = {
    agents: {},
    defaults: { agent: "claude", onManualMove: "yield", runMode: "supervised" },
    tracker: "plane",
    trackers: {},
};

function baseOpts(overrides: Partial<RunOptions> = {}): RunOptions {
    return {
        acpCommand: "claude-acp",
        cwd: "/repo",
        runMode: "autonomous",
        sessionKey: "CG-42",
        task: "do the thing",
        ...overrides,
    };
}

describe("resolveAcpCommand", () => {
    it("throws for an unconfigured agent", () => {
        expect(() => resolveAcpCommand("claude", undefined)).toThrow(/agent "claude" is not configured/);
    });

    it("returns the command alone when only command is set", () => {
        expect(resolveAcpCommand("claude", { command: "claude-acp" })).toBe("claude-acp");
    });

    it("joins command and acpArgs when both are set", () => {
        expect(resolveAcpCommand("omp", { acpArgs: ["acp"], command: "omp" })).toBe("omp acp");
    });

    it("prefers acpCommand over command when both are set", () => {
        expect(
            resolveAcpCommand("claude", {
                acpArgs: ["-y", "pkg"],
                acpCommand: "npx",
                command: "claude",
            }),
        ).toBe("npx -y pkg");
    });
});

describe("resolveAcpxCommand", () => {
    it("defaults to bunx acpx when tools is absent", () => {
        expect(resolveAcpxCommand(baseConfig)).toEqual(["bunx", "acpx"]);
    });

    it("defaults to bunx acpx when tools.acpx is absent", () => {
        expect(resolveAcpxCommand({ ...baseConfig, tools: {} })).toEqual(["bunx", "acpx"]);
    });

    it("defaults to bunx acpx when tools.acpx is empty", () => {
        expect(resolveAcpxCommand({ ...baseConfig, tools: { acpx: [] } })).toEqual(["bunx", "acpx"]);
    });

    it("returns a global install command when configured", () => {
        expect(resolveAcpxCommand({ ...baseConfig, tools: { acpx: ["acpx"] } })).toEqual(["acpx"]);
    });

    it("returns a pinned command when configured", () => {
        expect(
            resolveAcpxCommand({
                ...baseConfig,
                tools: { acpx: ["bunx", "acpx@0.10"] },
            }),
        ).toEqual(["bunx", "acpx@0.10"]);
    });
});

describe("buildAcpxArgs", () => {
    it("autonomous persistent (default) session", () => {
        expect(buildAcpxArgs(baseOpts())).toEqual([
            "--format",
            "json",
            "--json-strict",
            "--cwd",
            "/repo",
            "--approve-all",
            "--agent",
            "claude-acp",
            "prompt",
            "-s",
            "CG-42",
            "do the thing",
        ]);
    });

    it("supervised uses --approve-reads", () => {
        expect(buildAcpxArgs(baseOpts({ runMode: "supervised" }))).toEqual([
            "--format",
            "json",
            "--json-strict",
            "--cwd",
            "/repo",
            "--approve-reads",
            "--agent",
            "claude-acp",
            "prompt",
            "-s",
            "CG-42",
            "do the thing",
        ]);
    });

    it("always emits the global --agent for the acpCommand", () => {
        const args = buildAcpxArgs(baseOpts({ acpCommand: "npx -y pkg" }));
        expect(args).toEqual([
            "--format",
            "json",
            "--json-strict",
            "--cwd",
            "/repo",
            "--approve-all",
            "--agent",
            "npx -y pkg",
            "prompt",
            "-s",
            "CG-42",
            "do the thing",
        ]);
    });

    it("oneShot uses exec instead of -s", () => {
        expect(buildAcpxArgs(baseOpts({ oneShot: true }))).toEqual([
            "--format",
            "json",
            "--json-strict",
            "--cwd",
            "/repo",
            "--approve-all",
            "--agent",
            "claude-acp",
            "exec",
            "do the thing",
        ]);
    });

    it("appends --timeout when timeoutSeconds is set", () => {
        const args = buildAcpxArgs(baseOpts({ timeoutSeconds: 600 }));
        const idx = args.indexOf("--timeout");
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(args[idx + 1]).toBe("600");
    });

    it("emits all optional flags in the specified order", () => {
        const args = buildAcpxArgs(
            baseOpts({
                contract: "be careful",
                model: "claude-opus",
                nonInteractive: "fail",
                runMode: "supervised",
                suppressReads: true,
                timeoutSeconds: 600,
            }),
        );
        expect(args).toEqual([
            "--format",
            "json",
            "--json-strict",
            "--cwd",
            "/repo",
            "--approve-reads",
            "--non-interactive-permissions",
            "fail",
            "--append-system-prompt",
            "be careful",
            "--model",
            "claude-opus",
            "--agent",
            "claude-acp",
            "--timeout",
            "600",
            "--suppress-reads",
            "prompt",
            "-s",
            "CG-42",
            "do the thing",
        ]);
    });
});

describe("buildCancelArgs", () => {
    it("builds the cancel argv with globals before the subcommand", () => {
        expect(buildCancelArgs("CG-42", "/repo", "claude-acp")).toEqual([
            "--cwd",
            "/repo",
            "--agent",
            "claude-acp",
            "cancel",
            "-s",
            "CG-42",
        ]);
    });
});

interface SpawnCall {
    args: string[];
    cwd: string;
}

// A promise that never settles — handed to the injected `delay` so the deadline
// Branch can never win the race in the normal-completion test.
const never = new Promise<void>(() => {});

class FakeRunner implements ProcessRunner {
    readonly calls: SpawnCall[] = [];
    killCount = 0;

    constructor(
        private readonly cannedLines: string[] = [],
        private readonly exitCode = 0,
    ) {}

    spawn(args: string[], cwd: string): SpawnedProcess {
        this.calls.push({ args, cwd });
        const lines = this.cannedLines;
        return {
            exit: async () => this.exitCode,
            kill: () => {
                this.killCount += 1;
            },
            async *lines() {
                for (const line of lines) {
                    yield line;
                }
            },
        };
    }
}

// A runner whose lines() async-iterates forever until kill() ends the stream —
// Models a wedged acpx whose stdout never closes on its own. Killing it resolves
// The blocked iteration, exactly as ending a real process's stdout would.
class HangingRunner implements ProcessRunner {
    killCount = 0;

    spawn(): SpawnedProcess {
        let wake: (() => void) | undefined;
        // A hand-written async iterator (not a generator) whose next() blocks until
        // Kill() fires, then reports done — exactly like a real stdout closing on kill.
        const lines = (): AsyncIterable<string> => ({
            [Symbol.asyncIterator]: () => ({
                next: async (): Promise<IteratorResult<string>> => {
                    await new Promise<void>((r) => {
                        wake = r;
                    });
                    return { done: true, value: undefined };
                },
            }),
        });
        return {
            exit: async () => 0,
            kill: () => {
                this.killCount += 1;
                wake?.();
            },
            lines,
        };
    }
}

const FIXTURE = [
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"_meta":{"claudeCode":{"toolName":"Bash"}},"toolCallId":"toolu_01","sessionUpdate":"tool_call","rawInput":{},"status":"pending","title":"Terminal","kind":"execute","content":[]}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"toolCallId":"toolu_01","sessionUpdate":"tool_call_update","status":"completed"}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done. "}}}}',
    '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"```beflow-report\\n{\\"status\\":\\"done\\",\\"summary\\":\\"shipped\\"}\\n```"}}}}',
    '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
];

describe("AcpxDriver.run", () => {
    it("streams lines, reduces them, and extracts the report", async () => {
        const runner = new FakeRunner(FIXTURE, 0);
        const driver = new AcpxDriver({ runner });
        const events: unknown[] = [];

        const result = await driver.run(baseOpts(), (e) => {
            events.push(e);
        });

        expect(result.exitCode).toBe(0);
        expect(result.raw).toHaveLength(FIXTURE.length);
        expect(events).toHaveLength(FIXTURE.length);
        expect(result.stream.assistantText).toBe('Done. ```beflow-report\n{"status":"done","summary":"shipped"}\n```');
        expect(result.stream.stopReason).toBe("end_turn");
        expect(result.report).toEqual({ status: "done", summary: "shipped" });
        expect(runner.calls[0]!.args).toEqual(buildAcpxArgs(baseOpts()));
        expect(runner.calls[0]!.cwd).toBe("/repo");
    });

    it("returns a null report when the assistant emits no block", async () => {
        const runner = new FakeRunner(
            [
                '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}',
            ],
            0,
        );
        const result = await new AcpxDriver({ runner }).run(baseOpts());
        expect(result.report).toBeNull();
        expect(result.stream.assistantText).toBe("hi");
    });

    it("propagates a non-zero exit code", async () => {
        const runner = new FakeRunner([], 1);
        const result = await new AcpxDriver({ runner }).run(baseOpts());
        expect(result.exitCode).toBe(1);
    });

    it("returns timedOut false on normal completion and never kills the process", async () => {
        const runner = new FakeRunner(FIXTURE, 0);
        const driver = new AcpxDriver({ runner, delay: async () => never });
        const result = await driver.run(baseOpts({ timeoutSeconds: 600 }));
        expect(result.timedOut).toBe(false);
        expect(runner.killCount).toBe(0);
    });

    it("hits the hard deadline on a hung run: kills the process and returns timedOut true", async () => {
        // A runner whose lines() blocks forever until killed — models a wedged acpx.
        // The injected delay resolves the deadline deterministically (no real timers).
        const runner = new HangingRunner();
        let resolveDeadline: (() => void) | undefined;
        const driver = new AcpxDriver({
            delay: async () =>
                new Promise<void>((r) => {
                    resolveDeadline = r;
                }),
            runner,
        });
        const runPromise = driver.run(baseOpts({ timeoutSeconds: 600 }));
        // Let the consume loop start, then fire the deadline.
        await Promise.resolve();
        resolveDeadline?.();
        const result = await runPromise;
        expect(result.timedOut).toBe(true);
        expect(runner.killCount).toBe(1);
    });
});

describe("buildEnsureSessionArgs", () => {
    it("puts the global --cwd first, then the --agent sessions ensure subcommand", () => {
        expect(buildEnsureSessionArgs("CG-42", "/repo", "claude-acp")).toEqual([
            "--cwd",
            "/repo",
            "--agent",
            "claude-acp",
            "sessions",
            "ensure",
            "--name",
            "CG-42",
        ]);
    });
});

describe("AcpxDriver.ensureSession", () => {
    it("spawns the ensure args and resolves on exit 0", async () => {
        const runner = new FakeRunner([], 0);
        await new AcpxDriver({ runner }).ensureSession("CG-42", "/repo", "claude-acp");
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0]!.args).toEqual(buildEnsureSessionArgs("CG-42", "/repo", "claude-acp"));
        expect(runner.calls[0]!.cwd).toBe("/repo");
    });

    it("throws on a non-zero exit", async () => {
        const runner = new FakeRunner([], 1);
        expect(new AcpxDriver({ runner }).ensureSession("CG-42", "/repo", "claude-acp")).rejects.toThrow(
            /sessions ensure failed/,
        );
    });
});

describe("AcpxDriver.cancel", () => {
    it("spawns the runner with the cancel args", async () => {
        const runner = new FakeRunner();
        await new AcpxDriver({ runner }).cancel("CG-42", "/repo", "claude-acp");
        expect(runner.calls).toHaveLength(1);
        expect(runner.calls[0]!.args).toEqual(buildCancelArgs("CG-42", "/repo", "claude-acp"));
        expect(runner.calls[0]!.cwd).toBe("/repo");
    });
});
