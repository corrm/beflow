# MCP servers (per-run, via acpx)

beflow can hand the coding agent a set of **MCP servers** on a per-run basis. When
[`mcp.enabled`](config.md#top-level) is `true` in `config.json`, beflow reads a user `.mcp.json`, translates
it to the ACP `McpServer` shape, and injects it as a managed `.acpxrc.json` into the
agent's working directory. acpx merges `<cwd>/.acpxrc.json` and forwards its
`mcpServers` to the ACP `session/new` request.

> **Why a file, not a flag?** acpx forwards `config.mcpServers` to `session/new` but
> exposes no per-invocation CLI flag for it. The only injection point is
> `.acpxrc.json` in the agent's cwd, so beflow writes that file around the run and
> restores it afterward.

## Where it applies

| Mode              | Flag       | MCP injected?                                   |
| ----------------- | ---------- | ----------------------------------------------- |
| autonomous        | `--auto`   | **yes** — into the per-issue throwaway worktree |
| watch             | `watch`    | **yes** — same as `--auto`, per dispatched run  |
| supervised acpx   | `--attend` | **yes** — transiently into the repo checkout    |
| supervised native | `--open`   | **no** — agent's own native MCP config is used  |

`--open` launches the agent's native client (e.g. `claude`), not acpx, so its MCP
servers come from wherever that agent already reads them.

## Enabling it

```jsonc
// config.json
{
  "mcp": { "enabled": true },
}
```

When disabled (the default) or when no `.mcp.json` resolves to any server, beflow
injects nothing.

## The `.mcp.json` cascade

Two files are merged, **project wins per server name**:

1. **global** — `~/.beflow/.mcp.json`
2. **project** — `.mcp.json` beside `config.json`

Missing files are skipped. A project entry overrides a global entry that shares its
name; all other entries from both files are kept.

## Entry format

A Claude / oh-my-pi style map of `name → entry`. `type` defaults to `stdio`.

- **stdio** (default) — requires `command`; optional `args`, `env` (string-to-string record).
- **http** — requires `url`; optional `headers` (string-to-string record).
- **sse** — requires `url`; optional `headers` (string-to-string record).

```jsonc
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "bunx",
      "args": ["codegraph", "serve", "--mcp"],
      "env": { "CG_INDEX": "/path/to/index.db" },
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer TOKEN" },
    },
  },
}
```

## Translation to ACP shape

beflow translates each entry to the ACP `McpServer` shape:

- **stdio** carries **no `type` field** (it is the untagged union variant). `env` and
  `headers` flat records become `{ name, value }` pair arrays.
- **http / sse** keep their `type` tag and their `headers` flat record likewise
  becomes a `{ name, value }` pair array.

The `codegraph` example above produces:

```json
{
  "name": "codegraph",
  "command": "bunx",
  "args": ["codegraph", "serve", "--mcp"],
  "env": [{ "name": "CG_INDEX", "value": "/path/to/index.db" }]
}
```

The `docs` example produces:

```json
{
  "type": "http",
  "name": "docs",
  "url": "https://mcp.example.com/sse",
  "headers": [{ "name": "Authorization", "value": "Bearer TOKEN" }]
}
```

## Lifecycle and cleanup

beflow writes `<cwd>/.acpxrc.json` before the agent session and **restores** it in a
`finally` that wraps the whole run — even on throw, timeout, or cooperative cancel:

- If the file did **not** exist before, it is **removed** after the run.
- If it **did** exist, the **exact prior bytes** are written back (an unparseable
  prior is still restored verbatim). Any non-`mcpServers` keys you had are preserved
  while the run is live.

For `--auto`/`watch` the file lives in the throwaway worktree, so cleanup is
incidental. For `--attend` the file is written in place into the repo checkout, so
restore matters — consider adding `.acpxrc.json` to `.gitignore`.
