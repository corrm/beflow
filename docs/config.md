# Config reference

beflow reads a single `config.json` from the current working directory. Copy
[`config.example.json`](../config.example.json) to `config.json` and edit it:

```bash
cp config.example.json config.json
```

The file holds the tracker connection, the workspace + project registry, the
agent definitions, and global defaults. Keep `"$schema": "./config.schema.json"`
at the top for editor validation. API keys never live in this file — they are
read from environment variables (see [Secrets](#secrets)).

Run `beflow doctor` to validate the file and your environment.

---

## Top level

| Key         | Required | Description                                                                                               |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `tracker`   | yes      | Active tracker: `"plane"` or `"linear"`.                                                                  |
| `trackers`  | yes      | Per-tracker connection settings (see [Trackers](#trackers)).                                              |
| `defaults`  | yes      | Global run defaults (see [Defaults](#defaults)).                                                          |
| `workspace` | yes      | `{ id, slug }` of the tracker workspace.                                                                  |
| `projects`  | yes      | Map of project key → project config (see [Projects](#projects)).                                          |
| `agents`    | no       | Map of agent name → agent config (see [Agents](#agents)).                                                 |
| `worktrees` | no       | `{ dir }` where `--auto` runs create per-issue git worktrees. `~` expands; default `~/.beflow/worktrees`. |
| `runs`      | no       | `{ dir }` where run records persist for resume. Default `~/.beflow/runs`.                                 |
| `tools`     | no       | `{ acpx }` — the command array beflow spawns to run acpx. Default `["bunx", "acpx"]`.                     |
| `prompts`   | no       | `{ dir }` of user prompt-template overrides. See [prompts](prompts.md).                                   |
| `mcp`       | no       | `{ enabled }` — inject a `.mcp.json` cascade into agent runs. Default off. See [mcp](mcp.md).             |

## Trackers

```json
"trackers": {
  "plane": {
    "baseUrl": "https://api.plane.so",
    "workspaceSlug": "your-workspace",
    "apiKeyEnv": "PLANE_API_KEY"
  },
  "linear": {
    "apiKeyEnv": "LINEAR_API_KEY"
  }
}
```

Only the active tracker (`tracker`) needs to be present. `apiKeyEnv` names the
environment variable that holds the API key.

## Defaults

Global defaults; every project may override any of these under
`projects.<KEY>.<same-key>`.

| Key             | Required | Description                                                                                                                              |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`         | yes      | Default agent name (a key under `agents`).                                                                                               |
| `runMode`       | yes      | Default run mode: `autonomous` or `supervised`.                                                                                          |
| `assignee`      | no       | Tracker user id; beflow assigns the item to this user when it picks it up.                                                               |
| `onManualMove`  | no       | `yield` (default) lets a live run finish but skips writeback if a human moved the card; `abort` also cancels the agent.                  |
| `linkedContext` | no       | Inline parent-epic + attachment context into the agent task. Default on.                                                                 |
| `deadLetter`    | no       | `{ maxAttempts }` — failed attempts (crash-resume + CI-rework combined) before an item is quarantined to **Needs Input**. Default 3.     |
| `inputQuality`  | no       | `{ minBodyChars }` — a fresh autonomous dispatch of a too-thin issue is parked to **Needs Input** instead of running. Off when 0/absent. |
| `qualityGate`   | no       | `{ commands }` — check command(s) run in the worktree before an implement `done` opens a PR. On red, beflow reworks once, then fails.    |
| `review`        | no       | `{ enabled, postToPr }` — opt-in PR review assist in `watch`.                                                                            |
| `routing`       | no       | `{ triage, spec, implement }` — route a job kind to a specific agent name.                                                               |
| `sla`           | no       | `{ needsInputMinutes, inReviewMinutes }` — re-ping the escalation channel when an item ages past the threshold.                          |
| `telemetry`     | no       | `{ inComment }` — append a compact token/cost line to the writeback comment. Default off.                                                |

## Projects

Each entry maps a project key (e.g. `APP`) to a tracker project (a Plane project
or a Linear team) and the local repos its work lands in.

```json
"projects": {
  "APP": {
    "name": "My App",
    "plane_project_id": "00000000-0000-0000-0000-000000000000",
    "root": "/path/to/your/project",
    "default_repo": "main_repo",
    "repos": {
      "main_repo": "/path/to/your/project/main_repo",
      "website": "/path/to/your/project/website"
    },
    "module_repo_map": {
      "Backend": "main_repo",
      "Frontend": "website"
    },
    "limits": { "inReview": 5, "inProgress": 3 }
  }
}
```

| Key                | Required | Description                                                                                   |
| ------------------ | -------- | --------------------------------------------------------------------------------------------- |
| `name`             | yes      | Human-readable project name.                                                                  |
| `default_repo`     | yes      | Repo key (from `repos`) used when a run resolves no specific repo.                            |
| `repos`            | yes      | Map of repo key → absolute path on disk.                                                      |
| `module_repo_map`  | yes      | Map of board module name → repo key. Modules become Plane modules; they route work to a repo. |
| `root`             | yes      | Absolute path to the project root.                                                            |
| `plane_project_id` | no       | The Plane project UUID (Plane only; Linear maps the key to a team).                           |
| `limits`           | no       | `{ inReview, inProgress, maxRunMinutes }` — WIP caps and a per-run wall-clock limit.          |
| `defaults`         | no       | `{ agent, runMode }` overriding the globals for this project.                                 |
| `ci`               | no       | `{ autoReworkOnRed }` — re-dispatch rework when an In-Review PR's CI goes red.                |
| `routing`          | no       | Per-project job-kind → agent routing.                                                         |
| `scheduling`       | no       | `{ activeCycleOnly }` — only dispatch Todo items in the active cycle.                         |

Per-project `deadLetter`, `inputQuality`, `qualityGate`, `review`, `sla`, and
`telemetry` mirror their [Defaults](#defaults) counterparts and override them.

## Agents

Each entry defines how to launch one coding-agent CLI.

```json
"agents": {
  "claude": {
    "command": "claude",
    "args": ["--dangerously-skip-permissions"],
    "acpCommand": "bunx",
    "acpArgs": ["@agentclientprotocol/claude-agent-acp"],
    "model": "claude-opus-4-8"
  }
}
```

| Key          | Required | Description                                                                               |
| ------------ | -------- | ----------------------------------------------------------------------------------------- |
| `command`    | yes      | Interactive CLI binary used by `--open` (direct spawn).                                   |
| `args`       | no       | Extra args for the `--open` spawn (before the task).                                      |
| `acpCommand` | no       | ACP-server binary for `--auto`/`--attend` via acpx. Defaults to `command`.                |
| `acpArgs`    | no       | Args for the ACP server. beflow runs acpx `--agent "<acpCommand ?? command> <acpArgs…>"`. |
| `model`      | no       | acpx `--model` for `--auto`/`--attend`.                                                   |

## Secrets

API keys are read from the environment, never from `config.json`. Put them in a
gitignored `.env` (see `.env.example`):

```bash
PLANE_API_KEY=...
LINEAR_API_KEY=...
```

The variable names are whatever each tracker's `apiKeyEnv` points at.
