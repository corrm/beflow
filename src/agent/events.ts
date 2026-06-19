export interface AcpToolCall {
    id: string;
    title?: string;
    kind?: string;
    status?: string;
    toolName?: string;
}

export interface Usage {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export interface AcpStreamResult {
    assistantText: string;
    toolCalls: AcpToolCall[];
    stopReason?: string;
    error?: { code?: number; message: string };
    usage?: Usage;
}

export function parseAcpLine(line: string): unknown {
    const trimmed = line.trim();
    if (trimmed === "") {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

interface ToolName {
    _meta?: { claudeCode?: { toolName?: unknown } };
}

function readToolName(update: ToolName): string | undefined {
    const name = update._meta?.claudeCode?.toolName;
    return typeof name === "string" ? name : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function handleToolCall(toolCalls: AcpToolCall[], update: Record<string, unknown>): void {
    const id = asString(update.toolCallId);
    if (id === undefined) {
        return;
    }
    toolCalls.push({
        id,
        kind: asString(update.kind),
        status: asString(update.status),
        title: asString(update.title),
        toolName: readToolName(update as ToolName),
    });
}

function handleToolCallUpdate(toolCalls: AcpToolCall[], update: Record<string, unknown>): void {
    const id = asString(update.toolCallId);
    if (id === undefined) {
        return;
    }

    const status = asString(update.status);
    const title = asString(update.title);
    const toolName = readToolName(update as ToolName);

    const existing = toolCalls.find((call) => call.id === id);
    if (existing === undefined) {
        toolCalls.push({ id, status, title, toolName });
        return;
    }
    if (status !== undefined) {
        existing.status = status;
    }
    if (title !== undefined) {
        existing.title = title;
    }
    if (toolName !== undefined) {
        existing.toolName = toolName;
    }
}

// Lenient `usage_update` parse: the on-wire shape is unverified, so read token
// Counts defensively from either a nested `usage` object or the top-level update,
// Accepting camelCase AND snake_case. Any missing/non-numeric field is left
// Undefined; this NEVER throws. Returns undefined when no field was readable.
function parseUsage(update: Record<string, unknown>): Usage | undefined {
    const src = asRecord(update.usage) ?? update;
    const inputTokens = asNumber(src.inputTokens) ?? asNumber(src.input_tokens);
    const outputTokens = asNumber(src.outputTokens) ?? asNumber(src.output_tokens);
    const totalTokens = asNumber(src.totalTokens) ?? asNumber(src.total_tokens) ?? asNumber(src.used);
    const cacheReadTokens =
        asNumber(src.cachedReadTokens) ??
        asNumber(src.cacheReadTokens) ??
        asNumber(src.cache_read_tokens) ??
        asNumber(src.cacheReadInputTokens) ??
        asNumber(src.cache_read_input_tokens);
    const cacheWriteTokens =
        asNumber(src.cachedWriteTokens) ??
        asNumber(src.cacheWriteTokens) ??
        asNumber(src.cache_write_tokens) ??
        asNumber(src.cacheCreationInputTokens) ??
        asNumber(src.cache_creation_input_tokens);
    const costUsd =
        asNumber(src.costUsd) ??
        asNumber(src.cost_usd) ??
        asNumber(src.total_cost) ??
        asNumber(src.cost) ??
        asNumber(asRecord(src.cost)?.amount);

    const usage: Usage = {
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
    };
    return Object.keys(usage).length > 0 ? usage : undefined;
}

// Last-writer-wins merge: a later usage_update field overrides an earlier one,
// But a field absent from the new event keeps its prior value.
function mergeUsage(prior: Usage | undefined, next: Usage): Usage {
    return { ...prior, ...next };
}

function handleSessionUpdate(result: AcpStreamResult, update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
        case "agent_message_chunk": {
            const content = asRecord(update.content);
            if (content?.type === "text" && typeof content.text === "string") {
                result.assistantText += content.text;
            }
            return;
        }
        case "tool_call":
            handleToolCall(result.toolCalls, update);
            return;
        case "tool_call_update":
            handleToolCallUpdate(result.toolCalls, update);
            return;
        case "usage_update": {
            const parsed = parseUsage(update);
            if (parsed !== undefined) {
                result.usage = mergeUsage(result.usage, parsed);
            }
            return;
        }
        // Unknown sessionUpdate types (agent_thought_chunk, plan,
        // Available_commands_update, …) are ignored by design.
        default:
            return;
    }
}

export function reduceAcpStream(lines: Iterable<string>, onEvent?: (evt: unknown) => void): AcpStreamResult {
    const result: AcpStreamResult = { assistantText: "", toolCalls: [] };

    for (const line of lines) {
        const evt = parseAcpLine(line);
        if (evt === null) {
            continue;
        }
        onEvent?.(evt);

        const obj = asRecord(evt);
        if (obj === undefined) {
            continue;
        }

        if (obj.method === "session/update") {
            const update = asRecord(asRecord(obj.params)?.update);
            if (update !== undefined) {
                handleSessionUpdate(result, update);
            }
            continue;
        }

        const resultField = asRecord(obj.result);
        if (resultField !== undefined && typeof resultField.stopReason === "string") {
            result.stopReason = resultField.stopReason;
        }
        if (resultField !== undefined) {
            const resultUsage = parseUsage(resultField);
            if (resultUsage !== undefined) {
                result.usage = mergeUsage(result.usage, resultUsage);
            }
        }

        const errorField = asRecord(obj.error);
        if (errorField !== undefined && typeof errorField.message === "string") {
            result.error = {
                message: errorField.message,
                ...(typeof errorField.code === "number" ? { code: errorField.code } : {}),
            };
        }
    }

    return result;
}
