# Config reference

beflow reads its configuration from `~/beflow/config.json`. Running `beflow doctor` creates the file automatically on first run — open it, fill in your workspace details, and re-run.

The file holds the tracker connection, the workspace + project registry, the
agent definitions, and global defaults. The shipped `config.example.json`
includes a `$schema` pointing at the published JSON schema for editor
validation. API keys never live in this file — they are read from environment
variables (see [Secrets](#secrets)).

---

## Top level

| Key         | Required | Description                                                                                               |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `tracker`   | yes      | Active tracker: `"plane"` or `"linear"`.                                                                  |
| `trackers`  | yes      | Per-tracker connection settings (see [Trackers](#trackers)).                                              |
| `agent`     | yes      | Default agent name (a key under `agents`). See [Run defaults](#run-defaults).                             |
| `runMode`   | yes      | Default run mode: `autonomous` or `supervised`. See [Run defaults](#run-defaults).                        |
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

## Run defaults

These top-level keys set the defaults a run resolves against; every project may
override any of them under `projects.<KEY>.<same-key>`. `agent` and `runMode` are
the two required ones (listed in [Top level](#top-level)); the rest are optional.

| Key             | Required | Description                                                                                                                              |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
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

Each entry maps a project key (e.g. `MYAPP`) to a tracker project (a Plane project
or a Linear team) and the local repos its work lands in.

```json
"projects": {
  "MYAPP": {
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
| `agent`            | no       | Agent name overriding the global default for this project.                                    |
| `runMode`          | no       | Run mode overriding the global default for this project.                                      |
| `ci`               | no       | `{ autoReworkOnRed }` — re-dispatch rework when an In-Review PR's CI goes red.                |
| `routing`          | no       | Per-project job-kind → agent routing.                                                         |
| `scheduling`       | no       | `{ activeCycleOnly }` — only dispatch Todo items in the active cycle.                         |

Per-project `deadLetter`, `inputQuality`, `qualityGate`, `review`, `sla`, and
`telemetry` mirror their [Run defaults](#run-defaults) counterparts and override them.

### Repos: one project, several repositories

A beflow project is a single board, but the work on it often lands in **more
than one git repository** — say a backend service, a marketing site, and a
shared library. `repos` is the map from a short **repo key** to that
repository's absolute path on disk; it is the set of repositories a run is
allowed to touch. (`root` is just the common parent directory; `beflow doctor`
checks that `root` and every `repos` path exist.)

When beflow runs a work item it resolves **which** repo the agent works in, then
runs the agent in a git worktree of that repo:

1. `--repo <key>` on the command line wins, if given.
2. otherwise `module_repo_map` routes by the item's module — the board module
   maps to a repo key.
3. otherwise `default_repo` is the fallback.

See [resolution](resolution.md#repo) for the full cascade.

```json
"MYAPP": {
  "name": "My App",
  "root": "/home/you/projects/app",
  "default_repo": "api",
  "repos": {
    "api": "/home/you/projects/app/api",
    "web": "/home/you/projects/app/web",
    "shared": "/home/you/projects/app/shared"
  },
  "module_repo_map": {
    "Backend": "api",
    "Frontend": "web",
    "Shared Library": "shared"
  }
}
```

With the above, a work item filed under the **Backend** module runs in `api`, a
**Frontend** item in `web`, and a **Shared Library** item in `shared`. An item
with no module (or one not in the map) falls back to `default_repo` (`api`).
Override per run with `beflow run <KEY>-42 --repo web`.

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

API keys are read from the environment, never from `config.json`. Set them in
your shell profile (`~/.zshrc` or `~/.bashrc`) and reload:

```bash
# zsh:
echo 'export PLANE_API_KEY=...' >> ~/.zshrc  && source ~/.zshrc
# bash:
echo 'export PLANE_API_KEY=...' >> ~/.bashrc && source ~/.bashrc
# Windows PowerShell:
[System.Environment]::SetEnvironmentVariable("PLANE_API_KEY","your_token","User")
# Use LINEAR_API_KEY instead if you are on Linear.
```

The variable names are whatever each tracker's `apiKeyEnv` points at.
