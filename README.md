# beflow

**An AI-agent orchestration CLI that drives your issue tracker's backlog to
shipped PRs.**

[![npm](https://img.shields.io/npm/v/beflow?style=flat-square)](https://www.npmjs.com/package/beflow) [![CI](https://img.shields.io/github/actions/workflow/status/corrm/beflow/ci.yml?branch=main&style=flat-square)](https://github.com/corrm/beflow/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/github/license/corrm/beflow?style=flat-square)](https://github.com/corrm/beflow/blob/main/LICENSE)

![beflow demo](media/demo.gif)

beflow turns work items on a project board ([Plane](https://plane.so) or
[Linear](https://linear.app)) into agent-driven pull requests. You stay the
captain — decide, review, merge; beflow runs the crew — investigate, spec,
build, open PRs — and keeps the board in sync.

The agent is **tracker-blind**. All tracker I/O happens at the boundaries of a
run: beflow resolves a task + a repo + a contract, hands them to a coding-agent
CLI, and writes the structured result back to the board. The agent never knows
which tracker it's serving, so the same agent works across Plane and Linear.

```
   Tracker adapter           beflow core              Agent adapter
  (Plane | Linear)  ──fetch──▶  resolve repo+agent  ──run──▶  (claude | …)
        ▲                       +job kind+run mode              │
        └────────────────── write back report ◀────────────────┘
```

---

## Requirements

- **[Bun](https://bun.sh)** ≥ 1.0 — beflow runs on the Bun runtime.
- A **coding-agent CLI** that speaks [ACP](https://agentclientprotocol.com)
  (e.g. `claude`) plus [`acpx`](https://www.npmjs.com/package/acpx) (fetched
  automatically via `bunx`).
- **`git`** and the **`gh`** CLI (for the PR step).
- A **Plane** or **Linear** workspace and a personal API token.

## Install

```bash
bun add -g beflow      # or: npm i -g beflow
```

beflow is invoked with the Bun runtime, so Bun must be on your PATH. To run from
source instead:

```bash
git clone https://github.com/corrm/beflow.git
cd beflow
bun install
bun run build          # optional: compile a standalone ./dist/beflow binary
```

## Quickstart

```bash
# 1. Set your tracker API token in your shell profile:
#    zsh:   echo 'export PLANE_API_KEY=...' >> ~/.zshrc  && source ~/.zshrc
#    bash:  echo 'export PLANE_API_KEY=...' >> ~/.bashrc && source ~/.bashrc
#    PowerShell (Windows):
#           [System.Environment]::SetEnvironmentVariable("PLANE_API_KEY","your_token","User")
# Use LINEAR_API_KEY instead if you are on Linear.

# 2. Check your setup — creates ~/beflow/config.json on first run
beflow doctor
# Open ~/beflow/config.json, fill in your workspace slug, project IDs, and repo paths, then re-run.

# 3. Provision the board (creates the tracker project if it doesn't exist)
beflow setup <KEY>     # <KEY> is the project key in your config (e.g. APP, BE, WEB)

# 4. Run a work item, or start the watch daemon
beflow run <KEY>-42 --auto
beflow watch <KEY>
```

See the [config reference](docs/config.md) for every setting and
[`config.example.json`](config.example.json) for a complete starting point.

## Run modes

| Mode       | Flag                           | What it is                                                                                             |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Autonomous | `beflow run <KEY>-42 --auto`   | Headless. Isolated git worktree; for an implement job, opens a PR and moves the item to **In Review**. |
| Supervised | `beflow run <KEY>-42 --attend` | Interactive via acpx — you approve actions as they happen.                                             |
| Open       | `beflow run <KEY>-42 --open`   | Runs in the agent's own native TUI; you're present for a multi-turn session.                           |

Runs are **resumable**: each persists a run record and keeps its worktree until
the item is Done, so an interrupted run picks up where it left off.

## The board is the control center

beflow drives a simple board and you steer from it:

```
Backlog → Todo → In Progress → In Review → Done   (+ Needs Input, Cancelled)
```

`beflow watch` polls the queue and dispatches Todo items up to your
[WIP limit](docs/config.md#projects) (`limits.inProgress` / `limits.inReview`),
advances merged PRs to **Done**, reworks items you label `changes-requested`,
and answers items in **Needs Input** when you reply. See the
[lifecycle](docs/lifecycle.md) and [operating model](docs/OPERATING-MODEL.md).

## Commands

| Command                                                                        | What it does                                          |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`run <key>`](docs/commands.md#run-key)                                        | Run a work item through an agent                      |
| [`watch <project>`](docs/commands.md#watch-project)                            | Continuously poll a project's queue and dispatch work |
| [`setup` / `update <project>`](docs/commands.md#setup-project--update-project) | Provision/reconcile a project's board to the template |
| [`new <project> [template]`](docs/commands.md#new-project-template)            | Author a new work item from a template                |
| [`accept <project> <intake>`](docs/commands.md#accept-project-intake)          | Accept an intake item into the backlog                |
| [`review <key>`](docs/commands.md#review-key)                                  | Run an agent-driven review over a work item's open PR |
| [`queue`](docs/commands.md#queue-flags)                                        | Print the work queue across projects                  |
| [`runs [key]`](docs/commands.md#runs-key)                                      | Inspect persisted run records (read-only)             |
| [`doctor`](docs/commands.md#doctor---ping)                                     | Diagnose the local beflow environment                 |
| [`gc`](docs/commands.md#gc-flags)                                              | Find and prune orphaned git worktrees                 |

Full details — flags, examples, behavior — in the
**[command reference](docs/commands.md)**. Every command also supports `--help`.

## Configuration

beflow reads its configuration from `~/beflow/config.json` — the tracker
connection, your workspace + project registry, agent definitions, and global
defaults. Running `beflow doctor` creates the file automatically on first run —
open it, fill in your workspace details, and re-run. See
[`config.example.json`](config.example.json) for a complete reference.

A project maps a key to a tracker project and the local repos its work lands in:

```json
"projects": {
  "APP": {
    "name": "My App",
    "plane_project_id": "…",
    "root": "/path/to/your/project",
    "default_repo": "main_repo",
    "repos": { "main_repo": "…", "website": "…" },
    "module_repo_map": { "Backend": "main_repo", "Frontend": "website" }
  }
}
```

Every key — per-project overrides, agent definitions, and the opt-in gates
(dead-letter, quality gate, SLA, CI rework, review) — is documented in the
**[config reference](docs/config.md)**. API keys are set in your shell profile,
never in `~/beflow/config.json`.

## Documentation

- [Command reference](docs/commands.md) — every command and flag
- [Config reference](docs/config.md) — every `config.json` setting
- [Design](docs/DESIGN.md) — architecture and the run pipeline
- [Lifecycle](docs/lifecycle.md) — the board as the control center
- [Operating model](docs/OPERATING-MODEL.md) — the queue-based workflow
- [Resolution](docs/resolution.md) — how agent / mode / repo / job kind are chosen
- [Prompts](docs/prompts.md) — prompt templates and overrides
- [Issue templates](docs/issue-templates.md) — authoring work items with `beflow new`
- [Adapters](docs/adapters.md) — writing a tracker adapter
- [MCP](docs/mcp.md) — per-run MCP servers
- [ACP events](docs/acp-events.md) — the agent event stream beflow consumes

## License

[MIT](LICENSE)
