# Lifecycle: the board is the control center

In beflow, the issue tracker board is not a status report you update after the
fact — it **is** the control surface. Where a card sits, and which labels it
carries, is the single source of truth for what the agents are allowed to do.
Humans drive by moving cards and adding labels; beflow reacts by claiming work,
opening pull requests, and moving cards forward on its own.

This document describes the board states, the labels that govern behavior, and
exactly what moves an item between states — distinguishing **human actions**
from **beflow actions**.

- For the commands you run (`beflow watch`, `beflow run`, etc.), see
  [commands.md](./commands.md).
- For configuration keys referenced here (`deadLetter.maxAttempts`,
  `sla.*`, `inputQuality.minBodyChars`, limits, `module_repo_map`), see
  [config.md](./config.md).

---

## Board states

beflow provisions a fixed set of states on each project (see
`src/core/template.ts`):

| State           | Group     | Meaning                                                                                                               |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| **Backlog**     | backlog   | Raw, untriaged, or not-yet-ready work. Nothing runs here.                                                             |
| **Todo**        | unstarted | Ready to be worked. This is the dispatch queue: beflow pulls from here in priority order.                             |
| **In Progress** | started   | An agent is actively working the item (or a crashed run is being resumed).                                            |
| **Needs Input** | started   | Parked waiting on a human — a question, a decision, a thin description, or a quarantine. The human's daily scan lane. |
| **In Review**   | started   | Work is done and a pull request is open. Waiting on review / merge / CI.                                              |
| **Done**        | completed | Merged and finished.                                                                                                  |
| **Cancelled**   | cancelled | Dropped. Not worked.                                                                                                  |

The flow is **Backlog → Todo → In Progress → In Review → Done**, with
**Needs Input** as the universal parking lane an item can enter from any active
state and return to **In Progress** from. **Cancelled** is a terminal human
choice.

---

## Labels that govern behavior

Labels are the second control channel. beflow provisions these (see
`src/core/template.ts`); the human-facing ones are how you steer a running
board:

| Label                                                   | Who sets it       | Effect                                                                                           |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `changes-requested`                                     | Human             | On an **In Review** item, asks beflow to rework against your feedback.                           |
| `needs-decision`                                        | Human             | Holds an item for a human decision. beflow will not dispatch it.                                 |
| `blocked`                                               | beflow (or human) | Marks an external/unresolved blocker. Set by beflow when a run reports `blocked`.                |
| `quarantined`                                           | beflow            | Set when an item has failed too many times; beflow stops touching it until you remove the label. |
| `failed`                                                | beflow            | Set when a run reports a hard failure.                                                           |
| `triaged`                                               | beflow            | Set when a triage job finishes and the item returns to Backlog.                                  |
| `run:autonomous` / `run:supervised`                     | Human/config      | Selects how the item is run.                                                                     |
| `jobkind:triage` / `jobkind:spec` / `jobkind:implement` | Human/config      | Selects which kind of agent job runs.                                                            |
| `customer-reported`                                     | Human             | Provenance flag for externally reported work.                                                    |
| `agent:<name>`                                          | beflow            | Per-agent labels, provisioned at setup from the configured agents.                               |

---

## The human ↔ board ↔ agent loop

beflow runs the loop on every `beflow watch` tick (`src/core/watch.ts`). Each
tick reconciles the board against beflow's run records and takes the
appropriate actions. The pieces below are the actions a tick can take.

### 1. Dispatch (Todo → In Progress)

beflow pulls from **Todo** in priority order, up to the remaining capacity under
the In Progress WIP limit (`limits.inProgress`, default 3). Before dispatching a
candidate it applies filters:

- `blocked-by` walk — an item whose blockers are not all Done/Cancelled is
  skipped.
- `quarantined` items are skipped.
- when active-cycle narrowing is enabled, only items in the active cycle are
  considered.

Items that pass are dispatched concurrently (up to remaining capacity), each as
an autonomous run. The card moves **Todo → In Progress** and beflow claims it.

Two gates run on a **fresh** dispatch _before_ any worktree is created or the
board is claimed, so no run is wasted:

- **Thin-issue gate** (`src/core/inputquality.ts`): if
  `inputQuality.minBodyChars > 0` and the issue's human-visible description is
  shorter than that, the item is parked to **Needs Input** with a comment asking
  for a real description. (The check strips HTML and decodes entities, so it
  measures visible text, not markup.)
- **Decision gate** (`src/core/decision.ts`): if the item carries
  `needs-decision`, it is parked to **Needs Input** with a hold message and an
  escalation. See [the decision gate](#the-decision-gate) below.

### 2. Open a pull request (In Progress → In Review)

When a run finishes cleanly, beflow writes back to the board based on the run's
reported status (`src/core/resolution.ts` semantics):

| Reported status | Implement                               | Spec              | Triage                      |
| --------------- | --------------------------------------- | ----------------- | --------------------------- |
| `done`          | → **In Review** (+ link PR)             | → **Todo**        | → **Backlog** (+ `triaged`) |
| `needs_input`   | → **Needs Input** (+ questions comment) | → **Needs Input** | → **Needs Input**           |
| `blocked`       | → **Needs Input** (+ `blocked` label)   | → **Needs Input** | → **Needs Input**           |
| `failed`        | → **Needs Input** (+ `failed` label)    | → **Needs Input** | → **Needs Input**           |

For an implement job that produced a PR, the card moves **In Progress →
In Review** with the PR linked.

### 3. Auto-Done on merge (In Review → Done)

When PR-merge detection is enabled, each tick checks the open PR for every
**In Review** item. When the PR is **merged**, beflow moves the card
**In Review → Done** and cleans up the run record and the git worktree. No human
move is required — merging the PR is the signal.

### 4. PR review (In Review)

When review is enabled for the project, beflow runs a reviewer agent against the
open PR after the merge pass and, when configured, posts the findings as a PR
comment. This does not change state on its own — it surfaces findings for the
human or for a rework round.

---

## Rework

A card in **In Review** can be sent back for another round two ways. Both share
one universal attempt counter (`record.attempts`), which feeds the
[dead-letter](#dead-letter--quarantine) threshold.

### Human-requested: `changes-requested`

1. **Human** adds the `changes-requested` label to the **In Review** item and
   leaves a comment describing what to change.
2. If the label is present but **no comment** describes the change, beflow posts
   a one-time guidance comment ("You added the `changes-requested` label but
   haven't described the changes…") and parks — it will not guess.
3. With a comment present, **beflow** re-dispatches the item with the PR, the
   feedback comment(s), and the prior report as continuation context. The card
   returns to **In Progress** for the rework round.

### Automatic: CI-red rework

When CI-check polling is enabled, each tick checks the PR's checks for every
**In Review** item. If checks are **failing**, beflow re-dispatches a rework
round with the failing checks as context — exactly like `changes-requested`, but
triggered by red CI rather than a human. To avoid loops, beflow never reworks
the same head commit (SHA) twice. The attempt counter increments each round; at
the threshold the item is quarantined instead (see below).

---

## Answering Needs Input

**Needs Input** is the lane for everything parked on a human. To release an item:

- **For a question** (run reported `needs_input`): the **human** leaves a
  comment answering it. On the next tick **beflow** detects the new comment and
  re-dispatches the item with the answer as context — the card moves
  **Needs Input → In Progress**.
- **For a thin description**: the **human** adds a real description and leaves a
  comment; the same answered path re-activates it.
- **For a `blocked` / `failed` hold**: resolve the underlying issue, then the
  human comment re-activates it the same way.

---

## The decision gate

Some work should not start until a human has made a call. Label the item
`needs-decision`:

1. **Human** adds `needs-decision` (typically while the item is in Todo or
   Backlog).
2. On a fresh dispatch, **beflow** parks it to **Needs Input**, posts a hold
   message, and fires an escalation. It then **skips the item on every tick**
   until the label is gone — it never dispatches a decision-held item.
3. **Human** makes the call and **removes** the `needs-decision` label (and,
   optionally, leaves the rationale as a comment).
4. **beflow** releases it back into the normal **Todo → In Progress** flow.

---

## Dead-letter / quarantine

A poison item must never loop forever. beflow tracks a universal attempt counter
per item (`record.attempts`) that accumulates across **crash resumes,
CI-rework rounds, and quality-gate failures** (`src/core/deadletter.ts`).

When `attempts >= deadLetter.maxAttempts` (default 3), **beflow** quarantines the
item:

1. Adds the `quarantined` label.
2. Moves the card to **Needs Input**.
3. Posts a comment ("Quarantined after N failed attempts — the run kept crashing
   or could not finish.").
4. Fires an escalation and persists a quarantine hold on the run record.

Thereafter beflow **skips** the quarantined item entirely, so it cannot burn
more runs.

**To release:** the **human** removes the `quarantined` label. On the next tick
beflow moves the item back to **Todo**, resets the attempt counter, and fires a
"resolved" all-clear.

The counter also resets on a fresh dispatch, a human re-dispatch, or any clean
agent completion — so a transient failure does not permanently penalize an item.

---

## Crash resume and reconciliation

Because the board is the source of truth, beflow can recover from its own
crashes. Each tick scans run records with status `in_progress` (autonomous,
scoped to the project):

- If a record exists but the run is no longer live, beflow **resumes** it,
  keeping the card in **In Progress** — unless the attempt count has reached the
  quarantine threshold, in which case it quarantines instead.
- If the item was **manually moved away** from In Progress while a record
  existed, beflow logs it as **reconciled** and does _not_ resume — your manual
  move wins.
- If a record references a key that no longer exists on the board, the record is
  cleaned up as **orphaned**.

---

## SLA reminders

SLA reminders are an opt-in nudge for items sitting too long in a waiting lane
(`src/core/sla.ts`). They are **off by default**; set `sla.needsInputMinutes`
and/or `sla.inReviewMinutes` to enable them.

When an item's run-record age crosses the configured threshold, beflow fires a
`reminder` escalation and stamps the escalation time **without** bumping the
item's update time — so the age clock is not reset and reminders repeat each
threshold interval. When a previously-reminded item resolves (Needs Input
answered, or In Review merged to Done), beflow fires a one-shot `resolved`
all-clear. Reminders never change board state; they only notify.

---

## Summary: what moves an item

| Transition                 | Trigger                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| Backlog → Todo             | Human (ready it) or triage job completing                          |
| Todo → In Progress         | **beflow** dispatch (under WIP limit, filters pass)                |
| Todo/Backlog → Needs Input | **beflow** thin-issue or decision gate, on fresh dispatch          |
| In Progress → In Review    | **beflow** opens/links the PR on a clean implement run             |
| In Progress → Needs Input  | **beflow** writeback on `needs_input` / `blocked` / `failed`       |
| In Review → Done           | **beflow** auto-Done on PR merge                                   |
| In Review → In Progress    | Human `changes-requested` (+ comment), or **beflow** CI-red rework |
| Needs Input → In Progress  | Human comment answers / unblocks; **beflow** re-dispatches         |
| any active → Needs Input   | **beflow** quarantine at the attempt threshold                     |
| Needs Input → Todo         | Human removes `quarantined`; **beflow** releases + resets          |
| Todo → (released)          | Human removes `needs-decision`; **beflow** resumes normal flow     |
| → Cancelled                | Human                                                              |
