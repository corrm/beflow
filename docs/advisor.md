# Advisor

> **Status: v1 shipped (opt-in, `--auto` only).** The between-run deputy loop
> — after each agent run, review the committed work, correct on drift, escalate
> after `maxNudges` — is implemented for autonomous runs. The later phases (mid-run cancel, the `--open`
> close review, the multi-lens panel, and "learns you") are roadmap, not built;
> see _Rollout_.

The **advisor** is the captain's **stand-in**. While beflow runs an agent against
a ticket, a second model — the _deputy_, on its own context — reviews the agent's
work the way you would, steers it back on track the way you would, and only pulls
you in when it can't. beflow's promise is "you stay the captain"; the advisor lets
the captain step away and leave a deputy on watch.

Inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi)'s `advisor` role, but
wired to the levers beflow already owns — the rework loop, the board, and
cancellation — so the deputy can act, not just talk.

It is **opt-in** (`advisor.enabled: false` by default) and **tracker-blind**: the
deputy sees the task, the contract, and the agent's output — never the board.

---

## The gap it fills

beflow already gates a run **before** (preflight: decision + input-quality) and
**after** (quality gate, post-run policy, post-PR review). The "after" checks are
mechanical — _did the tests pass, did it touch a forbidden file_. None of them
catch the failure that wastes the most of your time: **the agent misunderstood the
ticket and built the wrong thing** (tests green, point missed).

The deputy is the missing checker: a model that judges the agent's work against
what the ticket actually asked for, and corrects it before that wrong-direction
change ever reaches your review queue.

---

## Advisor vs the review gate

beflow has two model-driven checks on agent work, at **opposite ends** of the
pipeline. They are complementary, not alternatives — the advisor keeps a run on
course so that by the time the [`review`](commands.md#review-key) gate looks at
the PR, there is less wrong with it.

|              | **Advisor** (this doc)                                   | **Review gate** (`beflow review`, `src/core/review.ts`) |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------- |
| When         | _During_ the work — between agent runs, before the PR    | _After_ the PR is open (item in **In Review**)          |
| Reviews      | Work in progress, against the ticket's contract          | The finished PR diff                                    |
| Output       | Corrections fed back to the **agent**; escalation to you | Findings posted as comments for **you**                 |
| Audience     | The agent itself                                         | The human reviewer                                      |
| Goal         | Stop wrong-direction work before it is "done"            | Catch issues in work that is already done               |
| Report block | `beflow-advisor`                                         | `beflow-review`                                         |

**When to use each**

- **Advisor** — turn it on for autonomous (`--auto`) runs you are not watching,
  where an agent can drift for a whole run before anyone notices. It earns its
  keep by killing wrong-direction work early, before it costs you a PR review.
- **Review gate** — use it for a human-style code review of a finished PR: run
  `beflow review <key>`, or enable the `review` gate so `watch` runs it. It judges
  done work; it does not steer the agent mid-flight.

Run both. The advisor reduces how often the review gate (and you) find something
wrong, because the worst drift never reaches the PR.

---

## How it works

beflow drives the agent as **one acpx prompt that runs to completion**
(`src/agent/acpx.ts` — `run()` blocks until the subprocess exits). There is no way
to whisper to the agent mid-run; a new prompt can only be sent once the previous
one finishes. So the deputy is **not a live whisperer**. It is a **reviewer in the
loop beflow already has**.

beflow already runs a loop today: _run the agent → check the result → re-dispatch
with a correction_ — that is exactly how `changes-requested` rework works
(`renderContinuation` + the rework loop in `src/core/run.ts`). The deputy slots
into that loop as a second checker, alongside the quality gate:

1. The agent finishes its run and commits.
2. The deputy reviews the committed diff against the ticket's contract.
3. Routing by severity:
   - `aside` → recorded on the run, no action.
   - `concern` → **re-dispatch the agent** with the correction as a continuation
     (the same path as a `changes-requested` rework), and loop.
   - `blocker` → **escalate** to Needs Input with the deputy's one-sentence reason.
4. If the same concern survives `maxNudges` re-dispatches, it is promoted to a
   blocker and escalated — the deputy stops re-dispatching an agent that won't
   listen.

The deputy is itself an agent from `config.agents`, invoked **read-only on its own
persistent session** (`-s <ISSUE-KEY>-advisor`), so across re-dispatches it
remembers what it already flagged and can tell whether the agent listened. Its
rubric is the **same contract beflow already renders** (`src/core/prompts.ts`
`renderContract`), which already inlines the issue's acceptance criteria — so it
checks "does this satisfy _this_ ticket," not generic taste.

### Default behavior: correct, then escalate

The everyday path is **correct and keep going** — the deputy does not pull you in
on every concern. The agent drifts, the deputy re-dispatches it with a correction,
the agent adjusts, the run continues. You are not pinged.

Escalation is the **safety valve, used rarely** — only when the agent ignores the
same correction `maxNudges` times, or does something genuinely unsafe. Two rules
keep this from dragging a good run sideways:

1. **Correct toward the ticket, not toward taste.** The rubric is the issue's
   acceptance criteria and the project's conventions — not the deputy's opinions.
   (Learning an individual captain's habits is a later upgrade; see _Rollout_.)
2. **Speak rarely.** A deputy that nitpicks gets switched off. It stays silent on a
   run that is going fine.

---

## Run modes

| Mode       | Deputy behavior                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--auto`   | Full loop: review after each agent run (between runs, never mid-run), re-dispatch on drift, escalate on `maxNudges`/unsafe. This is where the blind spot hurts most (no human watching).                                                                   |
| `--attend` | Same loop; its findings land next to your live approval prompts.                                                                                                                                                                                           |
| `--open`   | The agent runs in its own TUI (beflow can't see its turns). The deputy runs **once at session close**, over the final diff. No turn to re-dispatch — a `concern` becomes a PR-body note, a `blocker` holds the item out of In Review. Forced when enabled. |

> v1 implements `--auto` only. `--attend` and `--open` are roadmap (see _Rollout_).

---

## Severity → action

| Severity  | `--auto` / `--attend`                                            | `--open` (close review)                  |
| --------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `aside`   | record on the run                                                | record on the run                        |
| `concern` | **re-dispatch** the agent with the correction; record → PR body  | note in PR body                          |
| `blocker` | **escalate** → Needs Input with the deputy's one-sentence reason | hold item out of In Review → Needs Input |

A `concern` that survives `maxNudges` re-dispatches is promoted to a `blocker`.

Every action reuses machinery that already exists:

- **Re-dispatch** rides the same rework loop + `renderContinuation` beflow uses for
  `changes-requested` (same `-s <ISSUE-KEY>` session).
- **Escalate** uses the existing headless-escalation path (`notifyEscalation`,
  `escalationDetail`).
- **Mid-run cancel** — killing a run the instant it touches a `block`-listed path,
  before it even commits — is the one genuine mid-flight lever (`acpx cancel`). It
  needs live event-watching, so it is a later phase, not v1 (see _Rollout_).

---

## Multi-lens panel

`advisor.agents` is an array — each entry an agent from `config.agents` with its
own model (a security lens, a contract lens, a perf lens). Their verdicts merge
with the **same most-restrictive-wins** semantics the policy gate already
implements (`src/core/policy.ts`). One advisor is the common case; v1 uses the
first entry, the panel is a later phase.

---

## Configuration

Opt-in, and overridable per project through the existing precedence cascade. The
advisor reuses `config.agents` for its model(s); no schema fork. It mirrors the
shape of existing opt-in blocks (`mcp`, `policy`) across `src/config/schema.ts`
(Zod), `config.schema.json`, and `config.example.json`.

```jsonc
"advisor": {
  "enabled": false,               // opt-in — no surprise second model burning tokens
  "agents": ["gpt-5.5-reviewer"], // names from config.agents; v1 uses the first, array = future panel
  "maxNudges": 3                  // re-dispatches for one concern before escalating
}
```

| Field       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `enabled`   | Master switch. Off by default.                                              |
| `agents`    | One or more `config.agents` names to run as the deputy. v1 uses the first.  |
| `maxNudges` | How many times the deputy re-corrects an ignored concern before escalating. |

v1's rubric is fixed (the rendered jobKind contract) and the severity → action
mapping is fixed (the table above). `rubric`, `severityActions`, `modes`, and a
per-run `budget` are deferred to later phases (see _Rollout_) — until they are
honored they are not config, so they are not accepted.

> **Cost note.** Each review is a full acpx session, and each correction is a full
> agent re-run. A run that nudges 3× costs roughly one main run + three deputy
> reviews + three re-dispatches. `maxNudges` bounds this; keep it low.

---

## Rollout

Lazy first. Smallest version that proves the loop catches real drift:

1. **Between-turn loop v1** — one deputy from `config.agents`, reviews the
   committed diff after each agent turn, rubric = the rendered contract, two
   outcomes: `correct` (re-dispatch) and `escalate` (→ Needs Input). `--auto` only.
2. **Mid-run cancel / live policy** — watch the raw event stream; cancel a run the
   instant it touches a `block`-listed path. Extend to `--attend`.
3. **Close review** — the forced `--open` pass over the final diff + session
   history. Adds `modes` (which run modes the deputy is active in).
4. **Panel** — multi-agent `advisor.agents`, most-restrictive-wins merge.
5. **Tunable rubric + actions** — a `rubric` knob (`"contract"` or a path to a
   custom prompt), a `severityActions` map to override the fixed defaults, and a
   `budget.maxNotesPerRun` cost guard.
6. **Learns you** — the deputy corrects toward an individual captain's habits, not
   just the ticket. Only once the simple version proves itself.
