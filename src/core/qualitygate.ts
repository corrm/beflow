import { spawn } from "bun";

import type { Config, Registry } from "../config/schema.ts";

/**
 * Injectable command runner for the quality gate. Tests fake this; production uses
 * `defaultGateExec`. Returns the process exit code and the combined stdout+stderr.
 */
export type GateExec = (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;

export interface GateResult {
    output: string;
    passed: boolean;
}

const MAX_OUTPUT_CHARS = 16000;

/**
 * Project-over-default resolution of the per-project quality-gate commands. Returns
 * `[]` when neither layer sets `qualityGate.commands` (⇒ the gate is off).
 */
export function resolveQualityGate(config: Config, registry: Registry, projectKey: string): string[] {
    const projectCommands = registry.projects[projectKey]?.qualityGate?.commands;
    const globalCommands = config.qualityGate?.commands;
    return projectCommands ?? globalCommands ?? [];
}

/** Truncate from the front, keeping the tail (where errors usually surface). */
function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return `…(truncated)…\n${text.slice(text.length - MAX_OUTPUT_CHARS)}`;
}

/**
 * Run each command sequentially in `cwd`. The FIRST non-zero exit makes `passed:false`
 * and stops (later commands are not run); the combined stdout+stderr of every command
 * run so far is captured into `output` (truncated to a sane cap).
 */
export async function runQualityGate(commands: string[], cwd: string, exec: GateExec): Promise<GateResult> {
    const chunks: string[] = [];
    for (const command of commands) {
        const ran = await exec(command, cwd);
        chunks.push(`$ ${command}\n${ran.output}`);
        if (ran.exitCode !== 0) {
            return { output: truncate(chunks.join("\n\n")), passed: false };
        }
    }
    return { output: truncate(chunks.join("\n\n")), passed: true };
}

/**
 * Default runner: shell-parse the command string into an argv and spawn it in `cwd`,
 * mirroring `bunExec` (no shell, argv array). Combines stdout and stderr into `output`.
 */
export async function defaultGateExec(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const argv = parts.map((p) => p.replace(/^["']|["']$/g, ""));
    if (argv.length === 0) {
        return { exitCode: 0, output: "" };
    }
    const proc = spawn(argv, { cwd, stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { exitCode, output: stdout + stderr };
}
