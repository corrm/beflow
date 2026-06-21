# PR ownership and policy

This document covers two related features that ship together: **beflow-owned PR
creation** (`pr.owner: "beflow"`) and the **post-run policy gate** (`policy`).
Both are opt-in and affect only autonomous `implement` runs with a worktree.

---

## PR ownership modes

### `owner: "agent"` (default, back-compatible)

The agent handles the full GitHub workflow. It commits, pushes, and opens the
pull request using whatever tools it has available (typically `gh`). beflow
writes back the PR URL from the agent's structured report. This is the default
behavior and requires no config change.

### `owner: "beflow"`

The agent commits and pushes its branch, but **does not open a PR**. beflow
takes over from there: it opens a draft PR, runs the quality gate, evaluates
post-run policy, enriches the PR body, and then either marks the PR ready,
leaves it as a draft requiring human approval, or closes it. The board is
updated to reflect the outcome in every case.

Set this globally or per project:

```json
"pr": {
  "owner": "beflow",
  "baseBranch": "auto"
}
```

`baseBranch: "auto"` (the only supported value) tells beflow to detect the
repo's default branch at runtime. The `baseBranch` field accepts any string;
`"auto"` is the conventional value used in `config.example.json`.

---

## The beflow-owned pipeline

When `owner: "beflow"` is active, an autonomous `implement` run proceeds through
these steps:

1. **Decision gate** — if the issue carries a `needs-decision` label, it is
   parked to **Needs Input** immediately and a hold record is written. The label
   is the opt-in; removing it releases the issue back to Todo.

2. **Input-quality gate** — if the issue body is below the configured
   `minBodyChars` threshold, it is parked to **Needs Input** before any worktree
   is created, so no agent run is burned on an under-specified issue.

3. **Policy preflight** — the configured policy is run against the coarse file
   paths the issue _declares_ in its title and body, before any worktree is
   created. If that declared scope hits a `block` rule, the issue is parked to
   **Needs Input** immediately. See [The policy preflight](#the-policy-preflight)
   below; the post-run gate (step 9) remains authoritative.

4. **Create worktree** — beflow creates an isolated git worktree at
   `beflow/<key>` (under `worktrees.dir`). The agent runs inside it.

5. **Agent run** — the agent commits and pushes its branch. The contract
   explicitly instructs it not to open a PR; that step belongs to beflow.

6. **No-op check** — after the agent reports `done`, beflow checks whether the
   branch has any commits ahead of the base. If not (empty output), the run is
   parked as **failed** and the worktree is kept for inspection.

7. **Open draft PR** — beflow opens a draft PR titled
   `[beflow] <KEY>: <title>` from the pushed branch. The draft is the review
   artifact for the rest of the pipeline.

8. **Quality gate** — if `qualityGate.commands` are configured, they run in the
   worktree. On RED, the agent is re-prompted with the failing output up to
   `qualityGate.maxRework` times (default 1; `0` disables auto-rework), re-checking
   after each. If it is still RED once the rework budget is exhausted, the run is
   parked as **failed** (the draft PR is kept).

   **Baseline pinning** — by default the gate runs against the worktree's own test
   tree, which an autonomous agent could weaken (delete or soften an assertion) in
   the same branch so the gate self-grades green. When `qualityGate.baselineTestGlobs`
   is set, beflow pins the gate's definition-of-passing to the **target branch**:
   before each gate run it restores the changed files matching those globs from the
   base branch into the worktree, runs the commands against the run's implementation
   plus the baseline tests, then restores the worktree's own files. A change can no
   longer grade itself against tests it just modified. This is orthogonal to policy
   blast-radius: AGENTOWNERS governs _which paths_ a change may touch, while baseline
   pinning governs _which tests judge_ the change. The agent's test edits remain on
   the branch and are reviewed normally; only the automated gate run uses the
   baseline. Pinning engages only for beflow-owned runs (where the base branch and
   diff are known) and is off when the globs are unset.

9. **Post-run policy** — beflow evaluates the configured policy over the diff
   and decides the PR's fate (see [Policy outcomes](#policy-outcomes) below).

10. **Write back** — the board is updated and a comment is posted with the run
    summary and PR link.

---

## The policy preflight

The post-run gate (step 9) is authoritative: it judges the run's **actual diff**.
But that judgement only happens after beflow has built a worktree and spent a
full agent run (30–40 min) producing the diff. The preflight (step 3) is a cheap
fail-fast that runs the **same resolved policy** earlier, against the file paths
the issue declares, so a task that would _certainly_ be blocked is parked to
**Needs Input** before any of that work begins.

It is deliberately conservative — a false block is harmful, so the preflight
errs toward proceeding:

- **Coarse paths only.** The only signal is path-like tokens in the issue's
  title and body — a token with a path separator and a file extension
  (`infra/deploy.yaml`, `tests/x.test.ts`) or a dotfile-rooted path
  (`.github/workflows/ci.yml`). Prose, URLs, and bare identifiers are ignored.
- **Block-only short-circuit.** The preflight parks **only** on a confident
  `block` decision. `require_approval` and `allow` proceed normally; the
  post-run gate decides those over the real diff.
- **Empty signal proceeds.** If the issue declares no path-like tokens, the
  preflight does nothing — it never short-circuits on no evidence.
- **Same engage conditions as the post-run gate.** It runs only for an
  autonomous `implement` run with an active policy (`evaluator` is not `off`).
- **Same evaluator.** It reuses `resolvePolicy` + `evaluatePolicy` — one
  resolver, two call points. For the `agentowners` evaluator it reads
  `.github/AGENTOWNERS` from the **base repo** (which exists pre-worktree).

The honest caveat: the preflight is only as sharp as the paths an issue
declares. An issue that hides its blast radius in prose will sail past it and be
caught by the authoritative post-run gate instead. The preflight never _weakens_
that gate; it only short-circuits the unambiguous cases early.

### Predictive overlap warning (advisory)

On the proceed path — after the block short-circuit, when the declared scope is
about to be allowed through — the preflight also looks **backward**. It reads the
[decision log](#decision-log) and, when the issue's declared paths exactly overlap
paths a **prior** run in the **same project** sent to `block` or
`require_approval`, it logs a heads-up such as:

```
beflow: APP-42 — heads up: declared scope overlaps paths a prior run sent to block (APP-7: infra/secrets.tf); proceeding — the live policy gate remains authoritative
```

This is purely **advisory** — it **never** blocks or parks. The live policy gate
stays authoritative; history only surfaces a warning. Matching is exact on
repo-relative paths (no fuzzy / directory-prefix matching), it is scoped to the
current project, and lookback is bounded to recent history. A missing or partial
log simply yields no warning.

---

## Policy outcomes

| Decision           | What beflow does                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`            | Enriches the PR body with the agent's summary, marks the PR **ready for review**, and moves the issue to **In Review**.                                              |
| `require_approval` | Enriches the PR body, leaves the PR as a **draft**, moves the issue to **In Review**, and posts an awaits-approval note asking a human to approve and mark it ready. |
| `block`            | Closes the PR (keeping the branch for review and forensics), then routes the issue to **Needs Input** with a comment explaining the block reason.                    |

A `block` or `require_approval` decision is pre-PR governance: it runs before
the PR is visible to reviewers. It complements (and does not replace) GitHub
branch protection rules.

---

## Change receipt

On a finished `done` run the agent MAY emit a **change receipt**: a structured
statement of _intent_ and _risk surfaces_ alongside its report. It is carried
through the run record and handed to the post-run gate so the gate can judge what
the change is trying to do, not only which files it touched. The receipt is
**additive intent** — path rules remain the floor. The `globs` and `agentowners`
evaluators ignore it entirely (they decide on paths); only the `command`
evaluator receives it (on stdin, in the change context) and may judge it.

The agent emits the receipt inside its `beflow-report` block (see
[Prompts and contracts](prompts.md)). beflow knows the issue id and branch, so
the agent does not repeat them. Implement runs that change code SHOULD include
a receipt; triage and spec runs that change nothing may omit it.

| Field          | Required | Meaning                                                     |
| -------------- | -------- | ----------------------------------------------------------- |
| `intent`       | yes      | One or two lines: what the change does and why.             |
| `riskSurfaces` | yes      | The risk surfaces the change touches (taxonomy below).      |
| `surfaceNotes` | no       | A policy-relevant note per surface, keyed by surface name.  |
| `filesTouched` | no       | The files the agent claims it changed (beflow still diffs). |
| `testsRun`     | no       | Tests or commands the agent ran.                            |
| `uncertainty`  | no       | What the agent is unsure about.                             |
| `nextDecision` | no       | The next human decision needed, if any.                     |

Risk-surface taxonomy:

| Surface | Meaning                                                 |
| ------- | ------------------------------------------------------- |
| `app`   | Application/product code and business logic.            |
| `deps`  | Dependencies, lockfiles, package manifests.             |
| `infra` | Infrastructure, deployment, runtime config.             |
| `auth`  | Authentication, authorization, secrets, access control. |
| `data`  | Schemas, migrations, data handling, persistence.        |
| `ci`    | CI/CD pipelines and build automation.                   |

The gate evaluates the receipt **and** the diff: a `command` evaluator can return
`require_approval` or `block` informed by `riskSurfaces` (e.g. require approval for
any change that touches `auth`), while `changedFiles` still bounds the decision.

---

## Decision log

Every post-run policy decision is recorded as one append-only event in a local
**canonical decision log** — a sibling of the runs dir, default
`~/.beflow/decisions/decisions.ndjson` (override with `decisions.dir`). One NDJSON
line is written per decision, at decision time, **before** any of the writeback
branches run (and before the `allow` path's run-record GC). The tracker comment is
ephemeral and the run record is deleted on a clean writeback, so for an `allow`
this log is the only structured trace of _why_ the change was permitted.

Each line is a self-contained `DecisionEvent`:

```json
{
  "schemaVersion": 1,
  "decisionId": "a1b2c3d4-…",
  "runId": "APP-42@2026-06-20T00:00:00.000Z",
  "key": "APP-42",
  "prUrl": "https://github.com/acme/app/pull/99",
  "decision": "allow",
  "evaluator": "globs",
  "matchedRules": [{ "decision": "allow", "paths": ["src/**"] }],
  "changedFiles": ["src/api/auth.ts"],
  "reason": "rule decision=allow paths=src/**",
  "timestamp": "2026-06-20T00:00:00.000Z",
  "changedFilesHash": "…sha256…",
  "decisionInputHash": "…sha256…"
}
```

`matchedRules` is the structured companion to the flattened `reason` string: it
carries every rule that fired (its decision and matched paths/globs), not just the
winner. `changedFilesHash` and `decisionInputHash` are SHA-256 digests that make
the log tamper-evident for free. `evidence` and `approver` are reserved for a later
issue and are absent today.

The log is **append-only**: beflow never rewrites or truncates it. It is written
through a `DecisionSink` adapter — a stable interface with swappable
implementations. The local NDJSON sink is paired (via a `CompositeSink`) with a
best-effort tracker **receipt** sink that posts a human-readable summary of each
decision as a comment on the issue. The audit write always lands first; a tracker
outage logs and is swallowed, so it can never fail the run or lose the NDJSON
event. Set `decisions.comment` to `false` to opt out of the receipt comment. The
receipt body is not a forced format — it is a fully overridable
[`decision-receipt.md`](prompts.md#decision-receipt-template-decision-receiptmd)
prompt template. Object-storage or SIEM sinks are future drop-ins behind the same interface and the
same event shape, not a change to the record.

---

## Config reference

### `pr`

Applies globally unless a project-level `pr` block overrides it wholesale.

```json
"pr": {
  "owner": "agent",
  "baseBranch": "auto"
}
```

| Field        | Type                    | Description                                                             |
| ------------ | ----------------------- | ----------------------------------------------------------------------- |
| `owner`      | `"agent"` \| `"beflow"` | Who opens the PR. `"agent"` is the default.                             |
| `baseBranch` | `string`                | The PR base branch. Use `"auto"` to detect the repo default at runtime. |

### `policy`

Applies globally unless a project-level `policy` block overrides it wholesale.

```json
"policy": {
  "evaluator": "globs",
  "onBlock": "comment",
  "rules": [
    { "paths": ["infra/**", "**/*.tf"], "decision": "require_approval" },
    { "paths": [".github/**"],          "decision": "block" }
  ]
}
```

| Field             | Type                                                   | Description                                                                                              |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `evaluator`       | `"globs"` \| `"agentowners"` \| `"command"` \| `"off"` | How the policy is evaluated.                                                                             |
| `rules`           | `Rule[]`                                               | Ordered list of match rules (used when `evaluator` is `"globs"`).                                        |
| `agentownersPath` | `string`                                               | Path to the AGENTOWNERS file (used when `evaluator` is `"agentowners"`). Default: `.github/AGENTOWNERS`. |
| `command`         | `string[]`                                             | Command + args to invoke (used when `evaluator` is `"command"`).                                         |
| `onBlock`         | `"comment"`                                            | Side-effect on a `block` decision. `"comment"` posts the block reason to the issue.                      |

#### `policy.rules[]`

All matching rules are collected and the most restrictive decision wins
(`block` > `require_approval` > `allow`), so rule order does not matter. A rule
with no `paths` or `agent` filter matches everything and acts as a catch-all
default.

| Field      | Type                                           | Description                                                  |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `paths`    | `string[]`                                     | Glob patterns matched against the files changed in the diff. |
| `agent`    | `string`                                       | Match only when this agent ran the job.                      |
| `decision` | `"allow"` \| `"require_approval"` \| `"block"` | Required. The outcome when this rule matches.                |

`paths` are full-path globs matched against the changed file paths, so a rule
for a directory needs `infra/**`, not `infra`. A rule that matches nothing simply
does not fire — the change falls through to the next rule, and ultimately toward
`allow` if no rule matches.

#### `evaluator: "globs"` example

```json
"policy": {
  "evaluator": "globs",
  "onBlock": "comment",
  "rules": [
    { "paths": ["infra/**", "**/*.tf"], "decision": "require_approval" },
    { "paths": [".github/**"],          "decision": "block" },
    {                                   "decision": "allow" }
  ]
}
```

Rules are evaluated with most-restrictive-wins across all matched rules. The
final catch-all rule (no filters) ensures every run gets an explicit decision.

#### `evaluator: "agentowners"` example

The `agentowners` evaluator reads a CODEOWNERS-style file and runs the same
most-restrictive-wins engine as `globs`. It is the built-in alternative to
wiring a custom `command` hook for path-based ownership policies.

```json
"policy": {
  "evaluator": "agentowners",
  "agentownersPath": ".github/AGENTOWNERS"
}
```

**File format** — one rule per line: `<path-glob> <decision> [agent]`. `#`
starts a comment; blank lines are ignored. `decision` must be one of `block`,
`require_approval`, or `allow`. An optional third column scopes the rule to a
specific agent name; extra columns are malformed.

```
# AGENTOWNERS — most-restrictive wins: block > require_approval > allow
package.json        block
**/*.lock           block
infra/**            require_approval
.github/**          require_approval
src/**              allow              claude
*                   allow
```

**Missing file** — if the file does not exist at the resolved path, the
evaluator returns `allow` and logs the reason. A missing file is not an error.

**Malformed file** — an invalid decision token or a line with extra columns
causes a hard error: the run is parked as **failed** (fails closed). A broken
policy file never silently degrades to an allow.

**`agentownersPath` resolution** — a relative path is resolved against the
run's worktree root; an absolute path is used as-is. Pointing `agentownersPath`
at an absolute path outside the repo lets you keep the policy in a location the
agent cannot edit in the same change it governs. A relative in-repo path (the
default `.github/AGENTOWNERS`) is editable by the agent in the same change — if
that matters for your threat model, use an out-of-repo absolute path, or switch
to `evaluator: "command"` where you own the trust call entirely.

#### Recommended default (control-plane by default)

`beflow setup <PROJECT>` scaffolds a recommended `.github/AGENTOWNERS` into every
repo the project maps, so the out-of-the-box posture protects the control plane —
the paths that decide how "passing" is judged and how the repo ships. Existing
AGENTOWNERS files are never overwritten; setup logs which files it wrote versus
skipped.

```
# beflow recommended control-plane AGENTOWNERS
# These paths define how "passing" is decided and how the repo ships, so changes
# to them require human approval before merge. Tune to taste.
tests/** require_approval
.github/** require_approval
```

`.github/**` covers CI (`.github/workflows`) and the AGENTOWNERS file itself
(`.github/AGENTOWNERS`), so the gate is self-protecting. Both control-plane paths
default to `require_approval`, not `block`: a run that touches them still opens a
PR, but it stays a draft awaiting human sign-off.

Scaffolding only writes the file — it does **not** activate the gate. To turn it
on, set the evaluator in your beflow config (setup prints this reminder after it
writes a file):

```json
"policy": {
  "evaluator": "agentowners"
}
```

#### `evaluator: "command"` example

Use `"command"` to implement arbitrary policy logic behind a single hook.
beflow is not opinionated about the format of the ownership file; the hook can
implement whatever convention suits the repo.

```json
"policy": {
  "evaluator": "command",
  "command": ["node", "scripts/policy-check.js"]
}
```

beflow invokes the command and passes the change context as JSON on stdin:

```json
{
  "issueKey": "APP-42",
  "agent": "claude",
  "jobKind": "implement",
  "repo": "main_repo",
  "baseBranch": "main",
  "changedFiles": ["src/api/auth.ts", "infra/rds.tf"],
  "receipt": {
    "intent": "add a login route",
    "riskSurfaces": ["app", "auth"],
    "surfaceNotes": { "auth": "no change to token signing" }
  }
}
```

`receipt` is the agent's [change receipt](#change-receipt) and is present only when
the agent emitted one. The command may judge `intent` and `riskSurfaces` in addition
to `changedFiles` — but `changedFiles` remains the floor.

The command must write a single JSON object to stdout and exit 0:

```json
{ "decision": "require_approval", "reason": "infra/rds.tf requires ops approval" }
```

`decision` must be one of `"allow"`, `"require_approval"`, or `"block"`.
`reason` is included in the block comment and the tracker writeback when
provided. A non-zero exit or unparseable output causes the run to be parked as
failed (the worktree and draft PR are kept for inspection).

### Project-level overrides

A `projects.<KEY>.pr` or `projects.<KEY>.policy` block **replaces** the
corresponding global block wholesale — it does not merge with it. Use this when
a project needs different PR defaults or policy rules from the rest of the
workspace.

```json
"projects": {
  "INFRA": {
    "pr": { "owner": "beflow", "baseBranch": "auto" },
    "policy": {
      "evaluator": "globs",
      "onBlock": "comment",
      "rules": [
        { "decision": "require_approval" }
      ]
    }
  },
  "OPS": {
    "policy": {
      "evaluator": "agentowners",
      "agentownersPath": ".github/AGENTOWNERS"
    }
  }
}
```

---

## Scope

The beflow-owned PR pipeline and the post-run policy gate engage **only** for
autonomous (`--auto`) `implement` runs that use a worktree. They have no effect
on:

- Supervised (`--attend`) or open (`--open`) runs — a human is present in those
  modes and governs the outcome directly.
- Non-`implement` job kinds (`spec`, `triage`, `review`).
- Runs where `pr.owner` resolves to `"agent"` (the default).

Policy `block` and `require_approval` decisions operate before the PR is visible
to GitHub reviewers and complement (not replace) GitHub branch protection rules.
