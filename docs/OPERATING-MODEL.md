# Operating model

beflow is built around one idea: the issue tracker board is the control center,
and the work is a **priority queue** — not a set of sprints or cycles. This
document is the operating philosophy. For the mechanics of how cards move, see
[lifecycle.md](./lifecycle.md); for commands, [commands.md](./commands.md); for
configuration, [config.md](./config.md).

beflow is tracker-agnostic — the same model runs on Plane or Linear (see
[adapters.md](./adapters.md)).

---

## A priority queue, not sprints

There are no cycles to plan, no velocity to estimate, no sprint boundaries to
defend. Work is a single ordered queue:

- Anything ready to be worked sits in **Todo**, ordered by priority.
- beflow pulls from the top of that queue and dispatches agents.
- You reprioritize simply by reordering the queue — there is no commitment
  ceremony to break.

The unit of planning is "what should be worked next," answered continuously, not
"what fits in the next two weeks." If your tracker has cycles, you may optionally
narrow dispatch to the active cycle, but the core model does not require them.

---

## WIP limits, not capacity planning

Instead of estimating how much work fits in a period, beflow enforces
**work-in-progress limits** on the active lanes:

- **In Progress** is capped ([`limits.inProgress`](config.md#projects), default 3) — beflow dispatches
  from Todo only up to the remaining headroom under this cap.
- **In Review** is capped (`limits.inReview`, default 5) — this is the lane that
  protects _you_. Pull requests pile up here waiting on human review, and the cap
  is the backpressure that keeps beflow from producing more open PRs than you can
  realistically review.

WIP limits replace capacity planning: the queue is allowed to be arbitrarily
long; the limits decide how much is in flight at once.

See [config.md](./config.md) for the limit keys.

---

## Needs Input is your daily scan

Everything that requires a human decision collects in one lane: **Needs Input**.
A question from an agent, a held decision, a too-thin description, a quarantined
item — all of it parks here. That makes your daily routine simple:

> Open the board, scan **Needs Input**, clear what you can.

You answer a question by commenting, make a decision by removing the
`needs-decision` label, flesh out a thin issue by writing a real description and
commenting, or release a quarantined item by removing the `quarantined` label.
beflow picks each up on the next tick. You do not have to watch agents run — you
only have to service this one lane. The full set of release actions is in
[lifecycle.md](./lifecycle.md).

---

## `blocked` is a label for external waits

When work cannot proceed because of something outside the repo — a third-party
API, a dependency, a decision pending elsewhere — that is an **external wait**,
modeled with the `blocked` label rather than a board state. The card sits in
Needs Input carrying `blocked`; when the external condition clears, a human
comment releases it. beflow also walks `blocked-by` relations during dispatch, so
an item whose blockers are not yet Done is never picked up.

The distinction matters: a board _state_ is where work is in its lifecycle; a
`blocked` _label_ annotates _why_ it is waiting, without pretending the lifecycle
has moved.

---

## Repo standards live in each repo's CLAUDE.md

The ticket says **what** to do and **why**. It does not carry coding standards,
lint rules, test conventions, or architectural norms. Those live where the code
lives — in each repository's `CLAUDE.md` (and the repo's own config). An agent
working a card checks out the target repo and reads that repo's standards
directly.

This keeps tickets thin and portable, and keeps standards versioned alongside the
code they govern. When standards change, you change them in one place — the repo
— not across a backlog of tickets.

---

## One project, several repos

A project on the board can span several git repositories. A single work item maps
to the repo (or repos) its code area lives in via [`module_repo_map`](config.md#projects): a **module**
names a code area, and the map resolves that module to the repository beflow
should check out and open a PR against.

For example, project **APP** ("My App") might span two repos, `main_repo` and
`website`. The `module_repo_map` resolves each module to one of them, so a card
about the marketing site routes to `website` while a card about the core service
routes to `main_repo` — all from the same board.

See [config.md](./config.md) for the `module_repo_map` and per-project repo
configuration.

---

## How it fits together

- The **board** is the control center; you steer by moving cards and toggling
  labels.
- The **queue** (Todo, by priority) is what beflow pulls from.
- **WIP limits** decide how much is in flight; **In Review**'s limit is your
  review backpressure.
- **Needs Input** is the single lane you service daily.
- **Labels** (`blocked`, `needs-decision`, `changes-requested`, `quarantined`)
  carry the side-channel signals between you and the agents.
- **Repos** carry their own standards; **tickets** stay thin.

The precise state transitions behind all of this are documented in
[lifecycle.md](./lifecycle.md).
