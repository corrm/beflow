# beflow — Design

`beflow` turns issues on a project board into AI-agent work, across any tracker
and any agent CLI. You stay the captain (decide, review, merge); beflow runs the
crew (investigate, spec, build, open PRs) and keeps the board in sync.

See also: [README](../README.md) · [CLI reference](commands.md) · [Config reference](config.md) · [Lifecycle](lifecycle.md) · [Resolution](resolution.md) · [Adapters](adapters.md)

---

## 1. The keystone: the agent never touches the tracker

All tracker I/O happens at the **boundaries** of a run. In between, the agent is
**tracker-blind** — it gets a task + a repo + a contract, does the work, and
returns a structured report. The launcher writes the result back.

```
   Tracker adapter            beflow core               Agent adapter
  (Plane | Linear)  ──fetch──▶  resolve repo+agent   ──run──▶  (claude | opencode | …)
        ▲                       +jobKind+run-mode                  │
        │                                                          │
        └──────── write back ◀──── structured report ◀─────────────┘
        (state, comment, PR link)   (status, summary, prUrl, …)
```

Why it matters: **any agent × any tracker compose freely.** Add Linear → zero
agent changes. Add a new agent → zero tracker changes. The agent needs no tracker
MCP — beflow is the sole reader/writer of Plane and Linear.

---

## 2. Three layers

| Layer                        | Owns                                                                                       | v1 implementations                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Tracker adapter**          | ALL tracker reads/writes, behind one interface (REST/GraphQL, not MCP)                     | **Plane** (REST); **Linear** (GraphQL `@linear/sdk`)                                 |
| **Agent execution = `acpx`** | invoking + streaming any ACP agent: structured events, cancel, permission gating, sessions | agents fully specified in `config.agents`; beflow always passes acpx `--agent "<…>"` |
| **Core**                     | fetch → resolve → inject context → run → parse report → write back                         | —                                                                                    |

The core talks only to interfaces. Plane is the first adapter, never a hardcoded
dependency.

---

## 3. Normalized model (tracker-agnostic)

```ts
type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

interface Issue {
  id: string; // tracker UUID
  key: string; // human id, e.g. "APP-42"
  title: string;
  body: string;
  type?: string; // Bug | Feature | Chore | Spike
  state: { name: string; group: StateGroup };
  labels: string[];
  areas: string[]; // code areas — Plane "modules" / Linear "labels"
  priority?: string;
  meta: IssueMeta; // resolved per-issue overrides (see §6)
}

interface Tracker {
  getIssue(key: string): Promise<Issue>;
  listQueue(filter: QueueFilter): Promise<Issue[]>; // priority-ranked (urgent→none)
  updateState(issue: Issue, stateName: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  linkPR(issue: Issue, url: string, title?: string): Promise<void>;
  addLabel(issue: Issue, labelName: string): Promise<void>;
  readMetadata(issue: Issue): IssueMeta;
  listInbox(project: string): Promise<IntakeItem[]>; // Plane Intake / Linear Triage
  acceptInbox(project: string, item: IntakeItem): Promise<void>;
  ensureBoard(project: string, template: BoardTemplate): Promise<EnsureBoardResult>;
}
```

Mutating methods take the full `Issue` so the adapter can resolve the tracker
project from the key prefix. Project-scoped methods (`listInbox` / `acceptInbox` /
`ensureBoard`) take a `project` key because beflow is multi-project. `ensureBoard`
returns `EnsureBoardResult { created, skipped, warnings }` so setup can surface
the work-item-types toggle rather than silently "succeeding". The live Plane REST
contract is captured in [`plane-api-reference.md`](plane-api-reference.md).

State groups are the common denominator of Plane and Linear, so the 6-state board
(`Backlog → Todo → In Progress → Needs Input → In Review → Done` + Cancelled) maps
to both. `Needs Input` (started group) is the human-in-the-loop column.

For guidance on writing a new tracker adapter, see [`adapters.md`](adapters.md).

---

## 4. The run pipeline

Every `beflow run` (and every issue dispatched by `watch`) goes through these
stages in `src/core/run.ts`:

1. **Resolve** — apply the precedence cascade (CLI flags → issue meta → project
   defaults → global defaults → built-ins) to determine `agent`, `runMode`,
   `jobKind`, and `repo`. See [`resolution.md`](resolution.md).
2. **Quality gate** — thin-issue check (body below the minimum character
   threshold), decision-hold check (label `needs-decision` present), and any
   configured pre-run gates. A gate failure parks the issue to Needs Input with
   an explanatory comment rather than refusing silently.
3. **Claim the board** — fetch the live issue, guard against drift (if a human
   has already moved it out of the `started` group, yield to them and exit), then
   move it to `In Progress` and assign it to the configured agent identity.
4. **Create or resume the worktree** — see §5 below.
5. **Run the agent** — invoke acpx (or the native TUI for `--open`). The agent
   receives a rendered task + linked context and a jobKind contract injected as a
   system-prompt append. It returns a structured report via the NDJSON event
   stream.
6. **Write back** — `applyReport` maps the report status to a board move, posts a
   comment, links the PR, and optionally appends a telemetry line (token/cost
   summary, opt-in per project). If a human moved the card during the run, beflow
   yields state authority to them: it posts the agent's report as a comment,
   cleans up, and exits without overwriting the human's state.

---

## 5. Per-issue git worktrees and resumable runs

For any run that touches a git repo, beflow creates a dedicated `git worktree` in
a configured base directory:

```
<worktreesDir>/<sanitized-issue-key>/   ← isolated working tree
branch: beflow/<sanitized-issue-key>
```

This lets multiple issues run concurrently on the same repo without stepping on
each other — each has its own checkout and branch.

A **run record** (persisted in `<runsDir>/<ISSUE-KEY>.json`) captures the worktree
path, branch, agent, jobKind, runMode, and tracker at the start of each run. On a
subsequent `beflow run APP-42`, beflow detects the existing record and **resumes**:
it re-enters the same worktree and, for acpx-driven modes, continues the same
named acpx session (`-s APP-42`) so the agent retains full conversation context.
Only an unattended crash-resume increments the consecutive-attempts counter; a
human-initiated re-dispatch (after `changes-requested` or `Needs Input`) resets it.

After a successful writeback the worktree is removed and the run record deleted.

---

## 6. Agent execution via acpx (ACP, not CLI scraping)

beflow does **not** spawn raw agent CLIs or parse stdout/TTY. It drives `acpx` — a
headless Agent Client Protocol client — for a **structured event stream**,
**first-class cancellation**, **permission gating**, and **persistent sessions**.

A headless or supervised run is one acpx invocation:

```bash
acpx --format json --json-strict \
     --agent "<acpCommand ?? command> <acpArgs…>" -s <ISSUE-KEY> --cwd <repo> \
     <permission-flags> \
     --append-system-prompt "<jobKind contract>" "<task>"
```

- **beflow never uses acpx's built-in agent registry.** Every agent is fully
  specified in `config.agents`. An unconfigured agent is an error. The interactive
  binary (`command`, for `--open`) and the ACP-server binary (`acpCommand`,
  defaulting to `command`) may differ.
- **Output** is NDJSON: typed `tool_call`, message, and `stop` events. beflow
  consumes the stream — no temp file, no scraping.
- **Contract injection**: `--append-system-prompt` for Claude-family adapters; for
  agents whose ACP adapter ignores it, beflow prepends the contract to the task
  text. Same contract, two delivery paths.

### Run modes

Run modes are permission policy + session strategy, not stdio tricks.

| Flag       | Mode                      | acpx permission policy                             | Board lifecycle                                                                                                                           |
| ---------- | ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--auto`   | **autonomous** (headless) | `--approve-all` or a configured `--policy`         | beflow drives the full board lifecycle unattended; many can run concurrently (one worktree each)                                          |
| `--attend` | **supervised** (default)  | `--approve-reads`; writes escalate to the terminal | same board lifecycle, but you gate agent write-actions live                                                                               |
| `--open`   | **native TUI**            | n/a — agent's own client                           | beflow wraps the launch with the same drift guard, In Progress move, and outcome prompt on exit; shields Ctrl+C so the prompt always runs |

`watch` always dispatches in `--auto` mode.

**Headless escalation → Needs Input**: with `--non-interactive-permissions fail`
(or a `--policy` `escalate` rule), an autonomous run that hits an action it cannot
auto-decide stops; beflow moves the issue to Needs Input with the pending action as
the question.

**Sessions = work items.** Each acpx run uses `-s <ISSUE-KEY>` scoped to the repo
cwd, so a work item is a **resumable conversation**: when you request PR changes,
beflow continues the same session with full context instead of cold-starting.
Parallel items are parallel named sessions; `acpx sessions history` is the audit
trail.

### Structured report

The report rides the event stream — the final assistant message carries a JSON
block that beflow extracts:

````
```beflow-report
{ "status": "needs_input",
  "summary": "Refactored retry path; one open question.",
  "prUrl": null,
  "questions": ["Should retries be capped at 3 or configurable?"],
  "nextState": "Needs Input" }
```
````

```ts
type Report = {
  status: "done" | "needs_input" | "blocked" | "failed";
  summary: string;
  prUrl?: string;
  questions?: string[]; // when needs_input
  nextState?: string;
  notes?: string;
};
```

beflow maps `status` → board move: `done` → In Review (with PR link),
`needs_input` → Needs Input (+ posts questions as a comment), `blocked` → adds
`blocked` label, `failed` → stays In Progress (+ posts notes). For `--attend` and
`--open` runs that end without a JSON outcome, beflow prompts you for the outcome
and PR URL.

### Agent tooling (MCP)

By default the agent loads its native tools from its own config (for Claude Code:
the repo's `.mcp.json` / `.claude` settings). When `mcp.enabled` is set in
`config.json`, beflow **opts in** to feeding coding-tool MCP servers per session:
it reads a `.mcp.json` cascade (`~/.beflow/.mcp.json` ← project), translates it to
ACP `McpServer[]`, and injects it as a managed `.acpxrc.json` that acpx forwards on
`session/new`. This applies to acpx-driven runs (`--auto` / `--attend`); `--open`
uses the native client's own config. See [`mcp.md`](mcp.md).

The **one** tool the agent never gets — injected or native — is a tracker MCP. By
design: beflow owns all Plane/Linear I/O via REST, and the agent is tracker-blind.

---

## 7. Task and contract rendering

`src/core/prompts.ts` renders two strings that the agent receives on every run:

- **Task** (`renderTask`): the issue title, key, type, and description rendered
  into a configurable template. Linked context (parent epic body + attachments) is
  gathered from the tracker and appended here, not in the contract.
- **Contract** (`renderContract`): a jobKind-specific behaviour contract
  (`implement` | `spec` | `triage` | `review`) plus the `report` template that
  tells the agent exactly what JSON shape to emit. The contract is delivered via
  `--append-system-prompt` for Claude-family agents, or prepended to the task for
  others.

**JobKind auto-detect** (in core, tracker-agnostic): `issue.type + issue.state.group`
→ `triage | spec | implement | review`. The resolved jobKind selects the contract;
it can be overridden at any precedence level (see §8). See [`docs/prompts.md`](prompts.md)
for the default prompt templates.

---

## 8. One precedence cascade for every override

`agent`, `runMode`, `repo`, and `jobKind` all resolve the same way:

```
CLI flag  >  body-meta block  >  issue label  >  project default  >  global default  >  built-in
```

**Per-issue metadata** is carried in two places (body-meta block wins on conflict):

1. A **body-meta block** in the issue description (all four keys overridable):
   ```
   <!-- beflow
   agent: claude
   repo: main_repo
   runMode: autonomous
   jobKind: implement
   -->
   ```
2. An **issue label** — `agent:claude`, `run:autonomous`, `repo:main_repo`,
   `jobkind:implement` (note: label key is `run:`, not `runMode:`).

> **Plane caveat:** Plane's description editor strips HTML comments, so the
> body-meta block does not survive a save on Plane. On Plane, labels are the only
> per-issue mechanism. The body-meta > label precedence matters only on trackers
> that preserve the description block (e.g. Linear).

For the full cascade detail and all recognized label forms, see [`resolution.md`](resolution.md).

---

## 9. The watch daemon

`beflow watch <PROJECT>` is the board-as-control-center loop — the only automation
in v1 (no server, no webhook). On each tick it:

1. Counts issues currently `In Progress` and `In Review` against the project's
   capacity caps ([`limits.inProgress`, `limits.inReview`](config.md#projects) in `config.json`).
2. If under cap, fetches `Todo` issues ordered by priority.
3. Filters out issues that are quarantined (label `beflow:quarantined`), blocked
   by unfinished dependencies (`blockedBy`), or (when `scheduling.activeCycleOnly`
   is set) not in the active cycle.
4. Dispatches the top eligible items **concurrently** in `--auto` mode, each in
   its own worktree.
5. Handles housekeeping side-effects each tick:
   - Issues in `In Review` with a `changes-requested` label → re-dispatch with a
     continuation prompt (the review comment thread as context).
   - Issues in `In Review` with `needs-decision` → move to Needs Input with the
     open question surfaced as a comment.
   - When [`ci.autoReworkOnRed`](config.md#projects) is enabled, CI-failing PRs trigger a rework
     dispatch with the failure details as continuation context. Loop-safe: never
     reworks the same head SHA twice; quarantines a perpetually red PR once the
     attempt counter hits the [`deadLetter`](config.md#defaults) threshold.
   - Stale `In Progress` issues past the configured SLA window get a nudge comment.
6. Sleeps for `--interval` seconds (default 30) and repeats.

`watch` never launches supervised or native-TUI runs — those are always
user-initiated via `beflow run`. The daemon drains itself and surfaces only what
needs you.

**Hot-reload**: `watch` re-reads `config.json` on change (validated before
swapping; a bad save keeps the last-good config). In-flight issues are frozen to
the config they started under.

For the full lifecycle of every board column and every event, see [`lifecycle.md`](lifecycle.md).

---

## 10. PR flow

The **agent** does all code and git work and opens the PR via `gh`. It returns
`prUrl` in the report; **beflow records the link** on the issue. This is
consistent with the keystone — git is code work, linking is tracker work.

---

## 11. Config file

A single **`config.json`** holds everything. Top-level sections:

- **tracker + connection, global defaults:**
  ```json
  {
    "tracker": "plane",
    "trackers": {
      "plane": { "baseUrl": "https://…", "workspaceSlug": "your-workspace", "apiKeyEnv": "PLANE_API_KEY" },
      "linear": { "apiKeyEnv": "LINEAR_API_KEY" }
    },
    "agent": "claude",
    "runMode": "supervised"
  }
  ```
- **`workspace` + `projects`** — project keys → repos → areas, per-project
  defaults, and per-project `limits` (`inReview` / `inProgress` capacity caps).
- **`agents`** — per-agent binaries and args. `command` (required) + `args` drive
  the `--open` direct spawn. `acpCommand` (defaults to `command`) + `acpArgs`
  (joined into acpx `--agent`) + `model` drive `--auto` / `--attend`. An
  unconfigured agent is an error; beflow never falls back to acpx's built-in
  registry.
- **`tools.acpx`** — command array beflow uses to launch acpx; default
  `["bunx", "acpx"]`. Override to `["acpx"]` (global install) or
  `["bunx", "acpx@0.10"]` (pinned version).

**Secrets**: API keys come from env vars or a gitignored `.env`
(`PLANE_API_KEY`, `LINEAR_API_KEY`). Agent CLIs stay logged in on their own.

**Schema + validation**: `config.json` carries `"$schema": "./config.schema.json"`
for editor autocomplete. The schema is generated from the zod source via
`bun run gen:schema`; a test guards schema drift. At runtime beflow validates
before swapping on hot-reload.

For the full config reference, see [config.md](config.md).

---

## 12. CLI surface

```
beflow run <KEY> [--auto|--attend|--open] [--agent x] [--repo r]  # dispatch one issue
beflow queue [--project APP] [--state Todo]                       # cross-project "what's next" view
beflow watch <PROJECT> [--interval <seconds>] [--dry-run]         # poll Todo, dispatch within capacity caps
beflow accept <PROJECT> <INTAKE_ID>                               # Intake/Triage → Backlog
beflow setup <PROJECT>                                            # idempotent board bootstrap
```

`run` defaults to `--attend` (supervised). `watch` / `accept` / `setup` take the
project as a positional argument; `queue` uses `--project` / `--state` flags and
defaults to all projects / `Todo`.

For the full command reference including all flags, see [commands.md](commands.md).

---

## 13. `beflow setup` — shareable board bootstrap

Codifies the board (states, types, areas, labels) as a re-runnable, idempotent
template so any contributor gets a working board in one command. Some Plane
features are workspace-level (`work_item_types`) and are not settable via the API
— `setup` detects this and prints the one UI toggle the user needs to flip, rather
than silently "succeeding".

**Auth model `setup` prints guidance on:**

- **Tracker = a REST API key, not an MCP.** Generate a Plane/Linear personal API
  token and put it in beflow's `.env` (`PLANE_API_KEY` / `LINEAR_API_KEY`). That
  is the only tracker auth, and only beflow uses it.
- **Agent MCPs are optional and native.** Coding tools (codegraph, docs search,
  etc.) are configured where that agent already reads MCP config. beflow neither
  sets nor requires them — the kernel runs with zero MCPs.
- **Never add a Plane/Linear MCP to the agent.** beflow is the sole tracker writer
  (one source of truth, no double-writes) and injects all tracker context into the
  prompt.

---

## 14. Tech

- **TypeScript on bun.** Strict mode throughout.
- **Plane** via REST; **Linear** via `@linear/sdk`.
- Plane-first behind the adapter seam; Linear built second to keep the seam
  honest.
- Opinionated defaults (the operating model) shipped as a `setup` template, but
  the taxonomy is fully configurable. See [`OPERATING-MODEL.md`](OPERATING-MODEL.md).
