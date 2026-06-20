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

3. **Create worktree** — beflow creates an isolated git worktree at
   `beflow/<key>` (under `worktrees.dir`). The agent runs inside it.

4. **Agent run** — the agent commits and pushes its branch. The contract
   explicitly instructs it not to open a PR; that step belongs to beflow.

5. **No-op check** — after the agent reports `done`, beflow checks whether the
   branch has any commits ahead of the base. If not (empty output), the run is
   parked as **failed** and the worktree is kept for inspection.

6. **Open draft PR** — beflow opens a draft PR titled
   `[beflow] <KEY>: <title>` from the pushed branch. The draft is the review
   artifact for the rest of the pipeline.

7. **Quality gate** — if `qualityGate.commands` are configured, they run in the
   worktree. On RED, the agent is re-prompted once with the failing output. If
   it is still RED after rework, the run is parked as **failed** (the draft PR
   is kept).

8. **Post-run policy** — beflow evaluates the configured policy over the diff
   and decides the PR's fate (see [Policy outcomes](#policy-outcomes) below).

9. **Write back** — the board is updated and a comment is posted with the run
   summary and PR link.

---

## Policy outcomes

| Decision           | What beflow does                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`            | Enriches the PR body with the agent's summary, marks the PR **ready for review**, and moves the issue to **In Review**.                                              |
| `require_approval` | Enriches the PR body, leaves the PR as a **draft**, moves the issue to **In Review**, and posts an awaits-approval note asking a human to approve and mark it ready. |
| `block`            | Closes the PR and deletes the branch, then routes the issue to **Needs Input** with a comment explaining the block reason.                                           |

A `block` or `require_approval` decision is pre-PR governance: it runs before
the PR is visible to reviewers. It complements (and does not replace) GitHub
branch protection rules.

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

Each rule is matched in order; the first match wins. A rule with no `paths` or
`agent` filter matches everything and acts as a default.

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
  "changedFiles": ["src/api/auth.ts", "infra/rds.tf"]
}
```

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
