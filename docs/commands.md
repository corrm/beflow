# Command reference

Every beflow command. Run any command with `--help` for inline usage.

beflow is project-scoped: it reads `config.json` from the current working
directory. See the [config reference](config.md) for the file's shape and
[resolution](resolution.md) for how a run's agent, mode, and repo are chosen.

A **key** is a work item identifier such as `APP-42`. A **project** argument is
the registry project key (e.g. `APP`) — not the tracker's internal id.

---

## `run <key>`

Run a single work item through an agent.

```bash
beflow run APP-42            # use the project's default run mode
beflow run APP-42 --auto     # headless, autonomous
beflow run APP-42 --attend   # supervised, interactive via acpx
beflow run APP-42 --open     # supervised, in the agent's native TUI
```

beflow resolves the agent, run mode, job kind, and repo (see
[resolution](resolution.md)), moves the item to **In Progress**, runs the agent
with a task + contract, and writes the structured result back to the board.

| Flag             | Description                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--auto`         | Headless autonomous run via acpx. Creates an isolated git worktree and, for an implement job, opens a PR and moves the item to **In Review**. |
| `--attend`       | Supervised, interactive run via acpx (you approve actions; single turn).                                                                      |
| `--open`         | Supervised run in the agent's own native TUI (multi-turn; you are present).                                                                   |
| `--agent <name>` | Override the resolved agent (must be a key under `agents` in config).                                                                         |
| `--repo <name>`  | Override the resolved repo (must be a key under the project's `repos`).                                                                       |
| `--fresh`        | Ignore any saved session/worktree for this key and start over.                                                                                |
| `--dry-run`      | Print the resolved plan and exit — no board changes, no agent run.                                                                            |

Without `--auto`/`--attend`/`--open`, the run uses the resolved run mode
(`autonomous` or `supervised`) from config.

A run is **resumable**: it persists a run record (default `~/.beflow/runs`) and
keeps its worktree until the item is Done, so an interrupted run resumes in
place on the next `run`/`watch`.

## `watch <project>`

Continuously poll a project's queue and dispatch work — the daemon that drives
the [board lifecycle](lifecycle.md).

```bash
beflow watch APP                 # poll every 30s
beflow watch APP --interval 60   # poll every 60s
beflow watch APP --dry-run       # one tick, preview the decision, change nothing
```

Each tick resumes interrupted runs, advances merged PRs to **Done**, reworks
items with a `changes-requested` label, answers items in **Needs Input** that
got a new human comment, and dispatches fresh **Todo** items up to the project's
WIP limit. Opt-in passes (CI-red auto-rework, PR review, SLA reminders) run when
configured. Config is hot-reloaded between ticks.

| Flag                   | Description                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `--interval <seconds>` | Poll interval (default 30).                                                         |
| `--dry-run`            | Run a single observe-only tick that logs the dispatch decision and mutates nothing. |

## `setup <project>` / `update <project>`

Provision or reconcile a project's board to the beflow template (states,
labels, work-item types, and modules from `module_repo_map`). Idempotent:
creates what's missing, leaves matching items untouched. `update` is an alias of
`setup`.

If the project key is not yet in `config.json`, setup interactively creates the
tracker project (a Plane project / a Linear team), writes the config entry, then
provisions the board.

```bash
beflow setup APP
beflow update APP --prune   # also delete orphan modules / agent: labels
```

| Flag      | Description                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--prune` | Delete orphans (modules no longer in `module_repo_map`, `agent:` labels for agents no longer configured). Without it, orphans are only reported. |

## `new <project> [template]`

Author a new work item from a template (`bug`, `feature`, `spike`, `generic`).
Omit the template to pick interactively. See [issue templates](issue-templates.md).

```bash
beflow new APP bug
beflow new APP            # interactive template picker
```

## `accept <project> <intake>`

Accept an item from the tracker's intake inbox into the **Backlog**.

```bash
beflow accept APP <intake-item-id>
```

## `review <key>`

Run an agent-driven review over a work item's open PR and post the findings as a
comment. Read-only on the board — never merges or changes state.

```bash
beflow review APP-42
```

## `queue [flags]`

Print the work queue across projects.

```bash
beflow queue
beflow queue --project APP
beflow queue --state "In Review"
```

| Flag              | Description                       |
| ----------------- | --------------------------------- |
| `--project <key>` | Restrict to a single project.     |
| `--state <name>`  | Restrict to a single board state. |

## `runs [key]`

Inspect persisted run records (read-only).

```bash
beflow runs          # list all run records
beflow runs APP-42   # detail for one work item
```

## `doctor [--ping]`

Diagnose the local environment: config validity, API key presence, tool
availability (`bun`/acpx/`gh`), and project roots/repos on disk.

```bash
beflow doctor
beflow doctor --ping   # also hit the tracker read API and check board drift
```

## `gc [flags]`

Find and prune orphaned git worktrees beflow left behind. Reports by default.

```bash
beflow gc                      # report orphan worktrees
beflow gc --prune              # remove orphan worktrees with no pending work
beflow gc --prune --older-than 7
beflow gc --prune --force      # also remove worktrees with uncommitted/unpushed work (DESTRUCTIVE)
```

| Flag                  | Description                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| `--prune`             | Actually remove orphan worktrees (default: report only).                       |
| `--older-than <days>` | Only consider worktrees older than N days.                                     |
| `--force`             | Also remove worktrees with uncommitted/unpushed work — **destroys that work**. |
