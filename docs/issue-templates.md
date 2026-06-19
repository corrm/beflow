# Issue templates

`beflow new` authors a work item from a **template** — a Markdown file with a YAML
frontmatter block describing the issue's shape and a body with `{{key}}`
placeholders. beflow ships four defaults compiled into the binary, and you can
override any of them, or add your own, without rebuilding.

The model and loader live in
[`src/core/issuetemplate.ts`](../src/core/issuetemplate.ts); the compiled-in
defaults are the files under
[`src/prompts/defaults/issues/`](../src/prompts/defaults/issues/).

## The shipped defaults

| Template  | Type      | Priority | Job kind    | For                                                  |
| --------- | --------- | -------- | ----------- | ---------------------------------------------------- |
| `generic` | _(none)_  | _(none)_ | _(none)_    | A blank issue — summary plus free-form context.      |
| `bug`     | `Bug`     | `high`   | `implement` | A reproducible defect — steps, expected vs actual.   |
| `feature` | `Feature` | _(none)_ | `spec`      | A new capability — motivation + acceptance criteria. |
| `spike`   | `Spike`   | _(none)_ | `triage`    | A time-boxed investigation — a question to answer.   |

All four ship with `enrich: false` — predictable, no agent runs by default. Flip
`enrich: true` (see [below](#enrichment)) to have the agent investigate the repo
and write the issue for you.

## Frontmatter fields

The frontmatter is a YAML object. Only `name` and `description` are required.

| Field         | Type                                              | Meaning                                                                                           |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `name`        | string (**required**)                             | The template id — the file stem and the argument to `beflow new <KEY> <name>`.                    |
| `description` | string (**required**)                             | One-line summary shown in the interactive template picker.                                        |
| `agent`       | string                                            | Pins the agent → emits an `agent:<name>` picker label on the new card.                            |
| `jobKind`     | `triage` \| `spec` \| `implement`                 | Pins the lifecycle [job kind](resolution.md#job-kind) → emits a `jobkind:<jobKind>` picker label. |
| `runMode`     | `autonomous` \| `supervised`                      | Pins the [run mode](resolution.md#run-mode) → emits a `run:<mode>` picker label.                  |
| `type`        | string                                            | The work-item type (e.g. `Bug`, `Feature`, `Spike`).                                              |
| `priority`    | `urgent` \| `high` \| `medium` \| `low` \| `none` | The work-item priority.                                                                           |
| `state`       | string                                            | The state the issue is created into (defaults to `Backlog`).                                      |
| `labels`      | string[]                                          | Extra labels attached on creation, on top of the picker labels.                                   |
| `enrich`      | bool (default `false`)                            | Run the agent read-only to author the body before the preview.                                    |
| `title`       | string                                            | A `{{key}}` pattern for the title (see [Title](#title)).                                          |
| `questions`   | question[] (default `[]`)                         | The typed inputs collected from the operator (see [Questions](#questions)).                       |

## Questions

Each entry in `questions` is a typed input beflow asks the operator for. Keys must
be unique within a template.

| Field      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `key`      | The placeholder name — the answer fills `{{key}}` in the body.                          |
| `label`    | The prompt shown to the operator.                                                       |
| `type`     | `text` \| `longtext` \| `bool` \| `number` \| `options` \| `multiselect`.               |
| `required` | bool (default `false`) — required questions can't be left blank.                        |
| `options`  | string[] — **required** (non-empty) for `options` and `multiselect`; ignored otherwise. |

```yaml
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
  - { key: steps, label: Steps to reproduce, type: longtext, required: true }
  - { key: severity, label: Severity, type: options, options: [low, medium, high, critical] }
```

## Body substitution

The body (everything after the closing `---`) is rendered with the operator's
answers using the same `{{key}}` engine as prompt templates
([`src/core/prompts.ts`](../src/core/prompts.ts)). Every `{{key}}` is replaced by
the matching answer; referencing a key that no question supplies is a **hard
error** rather than a silent empty string, so typos are caught before the issue is
created.

## Title

If the frontmatter has a `title` pattern it is rendered the same way (e.g.
`title: "{{summary}}"`). With no pattern, beflow falls back to the `title` answer,
then `summary`, then the first question's answer. A template that produces an empty
title is an error — give it a `title` pattern or a `title`/`summary` question.

## Override cascade and embedding

For a given name, beflow resolves the first readable
`<dir>/<name>.md` in this order (highest priority first) and falls back to the
compiled-in default if none exist — identical to the [prompt cascade](prompts.md):

1. `./prompts/issues/<name>.md` — project-local, beside the loaded `config.json`.
2. `<prompts.dir>/issues/<name>.md` — the optional `prompts.dir` config key (a
   leading `~` expands to your home directory).
3. `~/.beflow/prompts/issues/<name>.md` — your personal global override.
4. The compiled-in default (`generic` / `bug` / `feature` / `spike`).

The defaults are embedded into the binary via `import … with { type: "text" }`, so
`beflow new` works with no files on disk. Override a shipped template by dropping a
file of the same name into one of the locations above, or add a brand-new template
by giving it a new name.

## Picker-label mapping

A template's `agent`, `jobKind`, and `runMode` are translated to the board's **picker
labels** on creation: `agent:<name>`, `jobkind:<jobKind>`, `run:<mode>`. The board
provisions these labels through [`beflow setup` / `beflow update`](commands.md#setup-project--update-project) — the `jobkind:*`
labels (`jobkind:triage`, `jobkind:spec`, `jobkind:implement`) are seeded alongside the
`run:*` pickers. After adding a template that pins a new `jobKind`, run
`beflow update <KEY>` once so the label exists. `createIssue` resolves each picker
label by name when it stamps the new card, so an authored issue enters the
[lifecycle](lifecycle.md) already routed by agent, jobKind, and run mode.

## Enrichment

With `enrich: true`, after the operator answers the questions beflow runs the
configured agent **read-only** to author the issue. The agent only reads and
searches the repository — it does not modify, create, or delete files — using the
answers, the assembled draft body, and the desired format as seed material, and
returns a single fenced `beflow-issue` block of JSON (see
[`src/agent/issuefence.ts`](../src/agent/issuefence.ts) and
[`src/prompts/defaults/issue-enrich.md`](../src/prompts/defaults/issue-enrich.md)).

The **template stays authoritative**: the fence's body replaces the draft, and a
refined `title` is taken if present, but the template's `type` and `priority` win —
the fence's suggestions only fill what the template leaves unset. Suggested labels
from the fence are appended on top of the picker labels. If the agent returns no
`beflow-issue` block, beflow falls back to the form draft. The operator always sees
the final preview and confirms before anything is created.
