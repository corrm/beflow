import type { RunMode } from "../model/types.ts";
import type { AcpStreamResult } from "./events.ts";
import type { Report } from "./report.ts";

// The agent-execution contract: the inputs, the result, and the surface that
// consumers depend on. Kept separate from the concrete acpx driver so callers
// and tests depend on the interface, not the implementation's private internals.

export interface RunOptions {
    sessionKey: string;
    cwd: string;
    runMode: RunMode;
    task: string;
    contract?: string;
    model?: string;
    // ACP-server command passed to acpx via `--agent`. Always set by beflow.
    acpCommand: string;
    oneShot?: boolean;
    nonInteractive?: "deny" | "fail";
    timeoutSeconds?: number;
    suppressReads?: boolean;
}

export interface AgentRunResult {
    exitCode: number;
    stream: AcpStreamResult;
    report: Report | null;
    raw: string[];
    // True when the driver hit its hard wall-clock deadline and killed the process
    // before it completed. False on every normal completion.
    timedOut: boolean;
}

export interface AgentDriver {
    run: (opts: RunOptions, onEvent?: (evt: unknown) => void) => Promise<AgentRunResult>;
    cancel: (sessionKey: string, cwd: string, acpCommand: string) => Promise<void>;
    ensureSession: (sessionName: string, cwd: string, acpCommand: string) => Promise<void>;
}
