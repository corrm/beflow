import { spawn } from "bun";

import type { AgentConfig, Config } from "../config/schema.ts";
import type { AgentDriver, AgentRunResult, RunOptions } from "./driver.ts";
import { parseAcpLine, reduceAcpStream } from "./events.ts";
import { extractReport } from "./report.ts";

const DEFAULT_ACPX_COMMAND = ["bunx", "acpx"] as const;

// Wall-clock grace added on top of acpx's own cooperative `--timeout`. acpx's
// `--timeout` is the first line of defence (it asks the agent to stop); this
// Grace is the window we give that cooperative stop before the driver's hard
// Kill backstops a wedged acpx.
const GRACE_SECONDS = 30;

// The configured acpx launcher (command + leading args), default `bunx acpx`.
export function resolveAcpxCommand(config: Config): string[] {
    const configured = config.tools?.acpx;
    return configured !== undefined && configured.length > 0 ? configured : [...DEFAULT_ACPX_COMMAND];
}

// Resolve the acpx `--agent` command string for an agent. beflow always fully
// Specifies the agent in config.agents and never relies on acpx's built-in
// Registry, so an unconfigured agent is an error.
export function resolveAcpCommand(agentName: string, cfg: AgentConfig | undefined): string {
    if (cfg === undefined) {
        throw new Error(`beflow: agent "${agentName}" is not configured in config.agents (add it with a "command")`);
    }
    return [cfg.acpCommand ?? cfg.command, ...(cfg.acpArgs ?? [])].join(" ");
}

export function buildAcpxArgs(opts: RunOptions): string[] {
    const args: string[] = ["--format", "json", "--json-strict", "--cwd", opts.cwd];

    args.push(opts.runMode === "autonomous" ? "--approve-all" : "--approve-reads");

    if (opts.nonInteractive !== undefined) {
        args.push("--non-interactive-permissions", opts.nonInteractive);
    }
    if (opts.contract !== undefined) {
        args.push("--append-system-prompt", opts.contract);
    }
    if (opts.model !== undefined) {
        args.push("--model", opts.model);
    }
    args.push("--agent", opts.acpCommand);
    if (opts.timeoutSeconds !== undefined) {
        args.push("--timeout", String(opts.timeoutSeconds));
    }
    if (opts.suppressReads === true) {
        args.push("--suppress-reads");
    }

    if (opts.oneShot === true) {
        args.push("exec", opts.task);
    } else {
        args.push("prompt", "-s", opts.sessionKey, opts.task);
    }

    return args;
}

export function buildCancelArgs(sessionKey: string, cwd: string, acpCommand: string): string[] {
    return ["--cwd", cwd, "--agent", acpCommand, "cancel", "-s", sessionKey];
}

export function buildEnsureSessionArgs(sessionName: string, cwd: string, acpCommand: string): string[] {
    return ["--cwd", cwd, "--agent", acpCommand, "sessions", "ensure", "--name", sessionName];
}

export interface SpawnedProcess {
    lines(): AsyncIterable<string>;
    exit(): Promise<number>;
    kill(): void;
}

export interface ProcessRunner {
    spawn(args: string[], cwd: string): SpawnedProcess;
}

export class BunProcessRunner implements ProcessRunner {
    public constructor(private readonly command: string[] = ["bunx", "acpx"]) {}

    public spawn(args: string[], cwd: string): SpawnedProcess {
        const proc = spawn([...this.command, ...args], {
            cwd,
            stderr: "inherit",
            stdout: "pipe",
        });

        async function* lines(): AsyncIterable<string> {
            const decoder = new TextDecoder();
            let buffer = "";
            for await (const chunk of proc.stdout) {
                buffer += decoder.decode(chunk, { stream: true });
                let newline = buffer.indexOf("\n");
                while (newline !== -1) {
                    yield buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf("\n");
                }
            }
            buffer += decoder.decode();
            if (buffer !== "") {
                yield buffer;
            }
        }

        return {
            exit: async () => proc.exited,
            kill: () => {
                proc.kill();
            },
            lines,
        };
    }
}

async function realDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

const MS_PER_SECOND = 1000;

export class AcpxDriver implements AgentDriver {
    private readonly runner: ProcessRunner;
    private readonly delay: (ms: number) => Promise<void>;

    public constructor(
        opts: { runner?: ProcessRunner; command?: string[]; delay?: (ms: number) => Promise<void> } = {},
    ) {
        this.runner = opts.runner ?? new BunProcessRunner(opts.command);
        this.delay = opts.delay ?? realDelay;
    }

    public async run(opts: RunOptions, onEvent?: (evt: unknown) => void): Promise<AgentRunResult> {
        const proc = this.runner.spawn(buildAcpxArgs(opts), opts.cwd);

        const raw: string[] = [];
        async function consume(): Promise<void> {
            for await (const line of proc.lines()) {
                raw.push(line);
                if (onEvent !== undefined) {
                    const evt = parseAcpLine(line);
                    if (evt !== null) {
                        onEvent(evt);
                    }
                }
            }
        }

        let timedOut = false;
        const consumed = consume();
        if (opts.timeoutSeconds === undefined) {
            await consumed;
        } else {
            const deadlineMs = (opts.timeoutSeconds + GRACE_SECONDS) * MS_PER_SECOND;
            const deadline = Symbol("deadline");
            const winner = await Promise.race([consumed, this.delay(deadlineMs).then(() => deadline)]);
            if (winner === deadline) {
                timedOut = true;
                // Hard kill: ending stdout terminates the in-flight `consume()` line
                // Iteration cleanly, so we await the SAME promise to drain it and avoid
                // A dangling unhandled rejection.
                proc.kill();
                await consumed;
            }
        }

        // OnEvent already fired live above; reduce the buffered lines for the result.
        const stream = reduceAcpStream(raw);
        const report = extractReport(stream.assistantText);
        const exitCode = await proc.exit();

        return { exitCode, raw, report, stream, timedOut };
    }

    public async cancel(sessionKey: string, cwd: string, acpCommand: string): Promise<void> {
        const proc = this.runner.spawn(buildCancelArgs(sessionKey, cwd, acpCommand), cwd);
        await proc.exit();
    }

    public async ensureSession(sessionName: string, cwd: string, acpCommand: string): Promise<void> {
        const proc = this.runner.spawn(buildEnsureSessionArgs(sessionName, cwd, acpCommand), cwd);
        for await (const line of proc.lines()) {
            void line; // drain stdout
        }
        const exitCode = await proc.exit();
        if (exitCode !== 0) {
            throw new Error(
                `beflow: acpx sessions ensure failed for session "${sessionName}" (exit ${String(exitCode)})`,
            );
        }
    }
}
