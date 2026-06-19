# acpx event stream — beflow agent-driver reference

This document describes the ACP JSON-RPC wire stream that beflow's `AcpxDriver`
(`src/agent/acpx.ts`) produces and how `reduceAcpStream` (`src/agent/events.ts`)
reduces it to a structured `AcpStreamResult`.

## Invocation

beflow spawns acpx with:

```
acpx --format json --json-strict --cwd <repo> <permission-flag> \
     [--append-system-prompt "<contract>"] [--timeout <seconds>] \
     prompt -s <SESSION-KEY> "<task>"
```

- `--format json` emits the **raw ACP JSON-RPC** wire stream as NDJSON (one JSON
  object per line). `--json-strict` suppresses non-JSON noise on stderr — always
  pair them.
- `<permission-flag>`: `--approve-all` in [autonomous mode](resolution.md#run-mode); `--approve-reads` in
  supervised mode.
- `--append-system-prompt` carries the [jobKind](resolution.md#job-kind) contract when one is configured.
- `--timeout` asks acpx to cooperatively stop after that many seconds; beflow adds
  a hard-kill grace window on top.
- `prompt -s <SESSION-KEY>` sends a prompt to a named, resumable session scoped by
  (agent, cwd, name). Cancel: `acpx --cwd <repo> --agent <cmd> cancel -s <SESSION-KEY>`.

## Line kinds (JSON-RPC)

- **Request** (acpx → agent): `{ jsonrpc, id, method, params }` — methods `initialize`,
  `session/new`, `session/prompt`.
- **Response**: `{ jsonrpc, id, result }` or `{ jsonrpc, id, error }`.
- **Notification** (agent → acpx): `{ jsonrpc, method:"session/update", params }` — the
  stream of agent activity. No `id`.

## session/update notifications — discriminated by `params.update.sessionUpdate`

- `agent_message_chunk` — assistant text. `params.update.content = {type:"text", text}`.
  **Concatenate the `text` of every chunk (in order) to rebuild the final message.**
- `agent_thought_chunk` — model thinking. Ignored by the driver.
- `tool_call` — `params.update = { toolCallId, sessionUpdate:"tool_call", title, kind
("execute"|"read"|"edit"|…), status ("pending"|"in_progress"|"completed"|"failed"),
rawInput, content, _meta.claudeCode.toolName }`.
- `tool_call_update` — same `toolCallId`; carries later `status`, `title`, `rawInput`,
  `rawOutput`, `content`, and tool result under `_meta.claudeCode.toolResponse`.
- `usage_update` — incremental token/cost counters. beflow parses this with
  `parseUsage` (camelCase and snake_case, nested `usage` object or top-level fields)
  and merges it into the running `AcpStreamResult.usage` via last-writer-wins.
- `plan`, `available_commands_update` — meta; ignored by the driver.

## Turn completion

The response to the `session/prompt` request carries the stop reason and final usage:

```jsonc
{ "id": "…", "result": { "stopReason": "end_turn" /* usage fields */ } }
```

`stopReason` values include `"end_turn"`, `"max_tokens"`, `"refusal"`,
`"cancelled"`, and others. beflow merges the usage from this response on top of
any `usage_update` totals accumulated during the turn. An `{ id, error }` response
means the turn failed.

## Usage accumulation

`AcpStreamResult.usage` is built from two sources, merged with last-writer-wins:

1. **`usage_update` notifications** during the turn — parsed leniently, accepting
   both camelCase (`inputTokens`) and snake_case (`input_tokens`) field names, and
   looking in either a nested `usage` object or the top-level update.
2. **The final `result` object** on the `session/prompt` response — parsed the same
   way and merged on top.

The `Usage` shape:

```ts
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}
```

## Permission requests (only when not auto-approved)

The agent sends a `session/request_permission` **request** (has an `id`) that the
client answers. With `--approve-all` none appear. With `--non-interactive-permissions
fail` an un-auto-answerable request makes the turn fail — beflow treats that as an
escalation and moves the issue to **Needs Input**.

## The report channel

beflow asks the agent (via the jobKind contract) to end its final message with a
fenced block labelled `beflow-report` containing report JSON. The driver rebuilds
the full assistant message by concatenating `agent_message_chunk` text values, then
`extractReport` (`src/agent/report.ts`) scans for the **last** ` ```beflow-report `
fence and parses its contents.

Report schema:

```ts
interface Report {
  status: "done" | "needs_input" | "blocked" | "failed";
  summary: string;
  prUrl?: string;
  questions?: string[];
  notes?: string;
}
```

If no valid fence is present, `extractReport` returns `null` and the run proceeds
without a structured report.
