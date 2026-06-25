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

## `setup <project>`

Register a project (creating it in the tracker, or **adopting** an existing one)
and reconcile its board to the beflow template (states, labels, work-item types,
and modules from `module_repo_map`). Idempotent: creates what's missing, leaves
matching items untouched.

Before anything else, setup verifies the tracker token with a cheap auth probe
and fails fast with an actionable message (naming the API-key env var, the
workspace slug, and `config.json`) — so a bad or unconfigured token surfaces up
front, not after you have filled in the interactive walkthrough. A workspace
slug still left at the bootstrap placeholder (`your-workspace`) is rejected
before any network call.

If the project key is **already** in `config.json`, setup just reconciles its
board. If it is not, setup runs an interactive walkthrough:

- It asks for the project name and identifier, then **checks the tracker right
  after the identifier** — if a project with that identifier already exists, it
  offers to **link** to it (adopting it into config) rather than failing with a
  "identifier already taken" error. Decline, and it re-prompts for a new
  identifier.
- The default repo key is **`main`**.
- The module→repo mapping prompt only appears when the project has more than one
  repo (with a single repo every module maps to it implicitly).

```bash
beflow setup APP
```

## `update <project>`

Push config changes (modules, states, labels, work-item types) to an **existing**
project's board. Unlike `setup`, `update` **never creates** a project: the key
must already be in `config.json`, otherwise it fails fast (offline) telling you
to run `beflow setup`. If the config entry has no tracker link yet, update
resolves one by identifier and persists it, then reconciles.

```bash
beflow update APP
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

This reviews a **finished PR** for you. For the in-run check that steers the agent
_while it works_, see [Advisor vs the review gate](advisor.md#advisor-vs-the-review-gate).

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

| Flag              | Description                                  |
| ----------------- | -------------------------------------------- |
| `--project <key>` | Restrict to a single project.                |
| `--state <name>`  | Restrict to a single board state.            |
| `--json`          | Emit machine-readable JSON instead of table. |

With `--json` the command writes a single `{ "rows": [...], "errors": [...] }`
document to stdout (each row is `{ project, key, state, title, priority? }`) and
suppresses the table. The exit code is unchanged (1 if any project errored).
Per-project errors are reported under `errors`; nothing is written to stderr.

## `runs [key]`

Inspect persisted run records (read-only).

```bash
beflow runs          # list all run records
beflow runs APP-42   # detail for one work item
beflow runs --json   # list every record as a JSON array
```

With `--json`, `runs <key>` emits the matching run record as a JSON object and
`runs` (no key) emits a JSON array of every record; the human-readable listing is
suppressed. Exit codes are unchanged — an unknown key still fails to stderr with
exit 1 and writes nothing to stdout.

## `doctor [--ping] [--fix] [--json]`

Diagnose the local environment: config validity (including a placeholder
workspace slug), API key presence, tool availability (`bun`/acpx/`gh`), project
roots/repos on disk, and a per-project **policy** line (each project's evaluator,
and for `agentowners` whether its file is present).

```bash
beflow doctor
beflow doctor --ping   # also hit the tracker read API and check board drift
beflow doctor --fix    # auto-repair the safe config/structure problems
beflow doctor --json   # emit machine-readable JSON instead of glyph lines
```

With `--json` the command writes a single
`{ "checks": [...], "ok": boolean }` document to stdout (each check is
`{ name, level, detail, fixable? }`) and suppresses the glyph lines and the
`--fix` hint; `--fix --json` also includes a `fixes` array of the repairs
applied. The exit code is unchanged (1 if any check failed).

When a problem is auto-fixable, plain `doctor` ends with a hint to run
`doctor --fix`. `--fix` only ever touches beflow-owned config and state — never
your repos, env vars, the tracker board, or installed tools. It performs exactly
three idempotent repairs:

1. **Config file** — if the config file is missing, write it from the built-in
   template; otherwise leave it.
2. **Tracker block** — if the active tracker has no entry under `trackers`, add
   the matching placeholder block (preserving every other key). A config file
   that is not valid JSON is reported, never overwritten.
3. **beflow dirs** — create the `worktrees`, `runs`, and `decisions`
   directories if they do not already exist.

Everything else (unset API key env var, missing repos on disk, no registered
projects, `acpx`/`gh` not on PATH, ping failures, board drift) is **not**
auto-fixable; `doctor` prints the exact manual remediation for each.

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
| `--json`              | Emit the machine-readable plan instead of the report lines.                    |

With `--json` the command writes a single
`{ "pruned": [...], "held": [...], "skippedByAge": [...] }` plan to stdout and
suppresses the report lines. Exit codes are unchanged. Because a destructive
`--force --prune` confirmation prompt would corrupt the JSON output, that
combination must be pre-authorized with `--yes`; otherwise `--json` fails to
stderr with exit 1 and writes nothing to stdout.
