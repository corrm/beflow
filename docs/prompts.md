# Prompts

Every agent run is driven by two pieces of text beflow assembles at the boundary:
a **contract** (the role the agent plays, plus the report instruction) and a
**task** (the work item, rendered into a block). Both are built from editable
Markdown templates. beflow ships faithful defaults compiled into the binary, and
you can override any of them without rebuilding.

The templating lives in [`src/core/prompts.ts`](../src/core/prompts.ts); the
compiled-in defaults are the files under
[`src/prompts/defaults/`](../src/prompts/defaults/).

## Template set

| File              | Used for                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `triage.md`       | The **triage** role — investigate and structure an item, no code.              |
| `spec.md`         | The **spec** role — produce an implementation plan, no code.                   |
| `implement.md`    | The **implement** role — do the work and open a reviewable PR.                 |
| `report.md`       | The report instruction appended to every contract (the `beflow-report` block). |
| `task.md`         | The work-item block handed to the agent as its task.                           |
| `continuation.md` | The continuation prompt handed to the agent when a run is resumed mid-work.    |
| `review.md`       | The review contract used for in-review PR checks (`renderReviewContract`).     |

These seven templates form the `PromptSet` interface and are all loaded by
`loadPromptSet`. The `continuation` and `review` templates are **not** appended
with `report.md`; `renderReviewContract` renders `review.md` alone.

A contract for a standard run is `<role>.md` (chosen by the resolved jobKind)
followed by a blank line and `report.md`. The task is `task.md` rendered with the
issue fields.

`report.md` also documents the optional **change receipt** — a structured
statement of intent and risk surfaces the agent may emit inside the
`beflow-report` block on a `done` run. The post-run policy gate carries it through
and may judge it; see
[Change receipt](pr-ownership-and-policy.md#change-receipt).

### Issue-authoring template (`issue-enrich.md`)

`issue-enrich.md` is a separate prompt used only by [`beflow new`](commands.md#new-project-template) `--enrich`. It is
**not** part of `PromptSet` and is loaded on demand by `loadEnrichPrompt`. It rides
the same override cascade as the rest of the templates. For the `beflow new`
issue-template system (the per-type Markdown frontmatter files), see
[docs/issue-templates.md](issue-templates.md).

### Decision-receipt template (`decision-receipt.md`)

`decision-receipt.md` is the body of the policy-decision receipt comment beflow
posts on a work item (when [`decisions.comment`](config.md#top-level) is not
`false`). It is **not** part of `PromptSet` and is loaded on demand by
`loadDecisionReceiptPrompt`, riding the same override cascade. There is no forced
format — drop your own `decision-receipt.md` into any override location to shape
the receipt however you like. A broken custom template (an unknown placeholder)
is logged and swallowed, so it can never fail a run.

Its placeholders, supplied by `buildReceiptContext`:

| Placeholder            | Value                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{decision}}`         | The decision label: `ALLOW`, `BLOCK`, or `REQUIRE APPROVAL`.                                                                                   |
| `{{evaluator}}`        | The policy evaluator that produced the decision.                                                                                               |
| `{{reason}}`           | The human-readable reason for the decision.                                                                                                    |
| `{{intentLine}}`       | Pre-composed `- Agent intent: <intent>` line with a leading newline from the agent's change receipt, or `""` when no receipt was emitted.      |
| `{{riskSurfacesLine}}` | Pre-composed `- Risk surfaces: <list>` line with a leading newline, or `""` when there is no receipt or no risk surfaces.                      |
| `{{surfaceNotesList}}` | Pre-composed, indented list of per-surface notes (capped at 20, `+N more` beyond); a leading newline when non-empty, `""` otherwise.           |
| `{{fileCount}}`        | The number of changed files.                                                                                                                   |
| `{{changedFilesList}}` | Pre-composed, indented list of changed files (capped at 20, `+N more` beyond); a leading newline when non-empty, `""` when there are no files. |
| `{{prLine}}`           | Pre-composed `- PR: <url>` line with a leading newline, or `""` when there is no PR.                                                           |
| `{{prUrl}}`            | The raw PR URL, or `""` when there is no PR.                                                                                                   |
| `{{key}}`              | The work-item key.                                                                                                                             |
| `{{runId}}`            | The run id the decision belongs to.                                                                                                            |
| `{{timestamp}}`        | The decision timestamp (ISO 8601).                                                                                                             |

## Placeholders

Templates use `{{name}}` placeholders (inner whitespace is allowed, e.g.
`{{ key }}`). The available keys are supplied by `buildPromptContext`:

| Placeholder       | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| `{{key}}`         | The work-item key, e.g. `APP-42`.                                      |
| `{{title}}`       | The work-item title.                                                   |
| `{{type}}`        | The work-item type, or `Unspecified` when the issue has none.          |
| `{{description}}` | The issue body, or `(no description provided)` when the body is blank. |
| `{{repo}}`        | The resolved repo key for the run.                                     |

Referencing any other placeholder is a **hard error** — beflow throws
`beflow: unknown placeholder "{{x}}" in <name> prompt` rather than silently
substituting an empty string. This catches typos before a run starts. The default
role and report templates contain no placeholders; only `task.md` uses them.

## Override cascade

For each template, beflow resolves the first readable file in this order
(highest priority first) and falls back to the compiled-in default if none exist:

1. `<configDir>/prompts/<name>.md` — project-local, beside the `config.json` beflow loaded.
2. `<prompts.dir>/<name>.md` — the directory named by the optional [`prompts.dir`](config.md#top-level)
   config key (a leading `~` expands to your home directory).
3. `~/.beflow/prompts/<name>.md` — your personal global override.
4. The compiled-in default (embedded in the binary at build time).

The cascade is per-template: you can override just `implement.md` and leave the
rest on their defaults. `issue-enrich.md` and `decision-receipt.md` use the same
three candidate paths under the same directories.

## Customizing

Copy a default out, edit it, and drop it into one of the override locations. For
a per-project tweak:

```sh
mkdir -p ./prompts
cp src/prompts/defaults/implement.md ./prompts/implement.md
# Edit ./prompts/implement.md however you like.
```

To point at a shared directory instead, set it in `config.json`:

```json
"prompts": { "dir": "~/my-beflow-prompts" }
```

The field is optional; leaving it out keeps beflow on the compiled-in defaults.

The shipped defaults are faithful to beflow's built-in behavior — overriding a
template changes only the text you change, nothing else.
