import type { Usage } from "../agent/events.ts";
import type { Config, Registry } from "../config/schema.ts";
import type { RunRecord } from "./runstore.ts";

// Project-over-default-over-false resolution of the per-project telemetry-in-comment
// Toggle. Returns false when neither layer opts in.
export function resolveTelemetryInComment(config: Config, registry: Registry, projectKey: string): boolean {
    return registry.projects[projectKey]?.telemetry?.inComment ?? config.defaults.telemetry?.inComment ?? false;
}

// The token count beflow reports: prefer an explicit total, else derive it from
// Input+output when both are present. Returns undefined when neither is derivable.
export function totalTokensOf(usage: Usage): number | undefined {
    if (usage.totalTokens !== undefined) {
        return usage.totalTokens;
    }
    if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        return usage.inputTokens + usage.outputTokens;
    }
    return undefined;
}

// Compact one-line telemetry suffix for the writeback comment. Degrade-safe:
// Returns undefined when usage carries neither a token count nor a cost, so the
// Caller writes no line. The token segment is omitted when no count is derivable;
// The cost segment is appended only when the event reported a cost.
export function formatTelemetryLine(
    usage: Usage,
    model: string | undefined,
    attempts: number | undefined,
): string | undefined {
    const tokens = totalTokensOf(usage);
    if (tokens === undefined && usage.costUsd === undefined) {
        return undefined;
    }
    const segments: string[] = [];
    if (tokens !== undefined) {
        segments.push(`${String(tokens)} tok`);
    }
    segments.push(`model ${model ?? "default"}`);
    segments.push(`attempt ${attempts !== undefined ? String(attempts) : "n"}`);
    let line = `beflow: ${segments.join(" · ")}`;
    if (usage.costUsd !== undefined) {
        line += ` · ~$${usage.costUsd.toFixed(4)}`;
    }
    return line;
}

function tokensLabel(usage: Usage | undefined): string {
    if (usage === undefined) {
        return "-";
    }
    const tokens = totalTokensOf(usage);
    return tokens !== undefined ? `${String(tokens)} tok` : "-";
}

// One compact line per record for the list view: key, status, attempts, tokens.
export function formatRunListLine(record: RunRecord): string {
    const attempts = record.attempts ?? 0;
    return `${record.key}  ${record.status}  attempts=${String(attempts)}  ${tokensLabel(record.usage)}`;
}

export function formatRunList(records: RunRecord[]): string[] {
    if (records.length === 0) {
        return ["beflow: no run records"];
    }
    return [...records].sort((a, b) => a.key.localeCompare(b.key)).map(formatRunListLine);
}

// Multi-line detail view for a single record. `model` is resolved by the caller
// (it lives in config, not the record) and may be undefined.
export function formatRunDetail(record: RunRecord, model: string | undefined): string[] {
    const lines: string[] = [
        `key: ${record.key}`,
        `status: ${record.status}`,
        `attempts: ${String(record.attempts ?? 0)}`,
        `agent: ${record.agent}`,
        `model: ${model ?? "default"}`,
        `jobKind: ${record.jobKind}`,
        `runMode: ${record.runMode}`,
    ];
    if (record.usage !== undefined) {
        const tokens = totalTokensOf(record.usage);
        if (tokens !== undefined) {
            lines.push(`tokens: ${String(tokens)}`);
        }
        if (record.usage.inputTokens !== undefined) {
            lines.push(`  input: ${String(record.usage.inputTokens)}`);
        }
        if (record.usage.outputTokens !== undefined) {
            lines.push(`  output: ${String(record.usage.outputTokens)}`);
        }
        if (record.usage.cacheReadTokens !== undefined) {
            lines.push(`  cacheRead: ${String(record.usage.cacheReadTokens)}`);
        }
        if (record.usage.cacheWriteTokens !== undefined) {
            lines.push(`  cacheWrite: ${String(record.usage.cacheWriteTokens)}`);
        }
        if (record.usage.costUsd !== undefined) {
            lines.push(`cost: ~$${record.usage.costUsd.toFixed(4)}`);
        }
    }
    if (record.prUrl !== undefined) {
        lines.push(`prUrl: ${record.prUrl}`);
    }
    if (record.reviewedSha !== undefined) {
        lines.push(`reviewedSha: ${record.reviewedSha}`);
    }
    lines.push(`updatedAt: ${record.updatedAt}`);
    return lines;
}
