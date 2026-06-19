# beflow

**An AI-agent orchestration CLI that drives your issue tracker's backlog to
shipped PRs.**

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
# 1. Create your config from the template and edit it
cp config.example.json config.json

# 2. Put your tracker API token in a gitignored .env
cp .env.example .env        # then fill in PLANE_API_KEY or LINEAR_API_KEY

# 3. Check your environment
beflow doctor

# 4. Provision the project's board (states, labels, types, modules)
beflow setup APP

# 5. Run a work item, or let the daemon drive the queue
beflow run APP-42 --auto
beflow watch APP
```

See the [config reference](docs/config.md) for every setting and
[`config.example.json`](config.example.json) for a complete starting point.

## Run modes

| Mode       | Flag                         | What it is                                                                                             |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Autonomous | `beflow run APP-42 --auto`   | Headless. Isolated git worktree; for an implement job, opens a PR and moves the item to **In Review**. |
| Supervised | `beflow run APP-42 --attend` | Interactive via acpx — you approve actions as they happen.                                             |
| Open       | `beflow run APP-42 --open`   | Runs in the agent's own native TUI; you're present for a multi-turn session.                           |

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

`run` · `watch` · `setup`/`update` · `new` · `accept` · `review` · `queue` ·
`runs` · `doctor` · `gc`

Full details — flags, examples, behavior — in the
**[command reference](docs/commands.md)**. Every command also supports `--help`.

## Configuration

beflow reads `config.json` from the current directory — the tracker connection,
your workspace + project registry, agent definitions, and global defaults. Start
from [`config.example.json`](config.example.json):

```bash
cp config.example.json config.json
```

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
**[config reference](docs/config.md)**. API keys live in a gitignored `.env`
(see `.env.example`), never in `config.json`.

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
