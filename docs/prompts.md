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

### Issue-authoring template (`issue-enrich.md`)

`issue-enrich.md` is a separate prompt used only by `beflow new --enrich`. It is
**not** part of `PromptSet` and is loaded on demand by `loadEnrichPrompt`. It rides
the same override cascade as the rest of the templates. For the `beflow new`
issue-template system (the per-type Markdown frontmatter files), see
[docs/issue-templates.md](issue-templates.md).

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
2. `<prompts.dir>/<name>.md` — the directory named by the optional `prompts.dir`
   config key (a leading `~` expands to your home directory).
3. `~/.beflow/prompts/<name>.md` — your personal global override.
4. The compiled-in default (embedded in the binary at build time).

The cascade is per-template: you can override just `implement.md` and leave the
rest on their defaults. `issue-enrich.md` uses the same three candidate paths
under the same directories.

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
