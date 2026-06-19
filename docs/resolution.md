# Resolution

When beflow picks up an issue it resolves four things before it can run an agent:
**agent**, **run mode**, **job kind**, and **repo**. All four go through the
same `cascade` helper in [`src/resolve/precedence.ts`](../src/resolve/precedence.ts):
the first non-`undefined` value in a priority-ordered list wins. Empty string and
`0` are valid values and do not trigger a fallback; only `undefined` does.

## Sources

Each field can be supplied from up to four sources, in priority order:

| Source    | What it is                                                                            |
| --------- | ------------------------------------------------------------------------------------- |
| `cli`     | Command-line flags passed to [`beflow run`](commands.md#run-key) for this invocation. |
| `meta`    | Per-issue metadata parsed from the issue body and labels (see below).                 |
| `project` | The matching project entry in `config.json` (e.g. its `agent` / `runMode` keys).      |
| `global`  | The top-level keys in `config.json` (e.g. `fileSchema.agent` / `fileSchema.runMode`). |

### Per-issue metadata (`meta`)

`parseIssueMeta(body, labels)` in [`src/resolve/metadata.ts`](../src/resolve/metadata.ts)
merges two sources. Labels are parsed first, then the body block overwrites any
field the body also sets (body wins on conflict).

**Body block** — an HTML comment anywhere in the issue description:

```
<!-- beflow
agent: claude
repo: main_repo
runMode: autonomous
jobKind: spec
-->
```

The parser scans `key: value` lines inside the comment. Recognised keys:
`agent`, `repo`, `runMode`, `jobKind`.

**Labels** — issue labels of the form `key:value`. Recognised keys:
`agent`, `repo`, `run` (note: `run`, not `runMode`), `jobkind`.

Examples: `agent:claude`, `run:autonomous`, `repo:main_repo`, `jobkind:implement`.

The merged result is an `IssueMeta` object (`agent?`, `repo?`, `runMode?`, `jobKind?`).

> **Plane caveat:** Plane's description editor strips HTML comments, so the
> `<!-- beflow ... -->` body-meta block does not survive a save and is ignored.
> On Plane, labels are the only per-issue mechanism. The body-meta > label
> precedence only matters on trackers that preserve the description block (e.g.
> Linear), where a body-meta block overrides any conflicting label.

## Agent

**Precedence:** `cli.agent` → `meta.agent` → `project.routing[jobKind]` →
`global.routing[jobKind]` → `project.agent` → `global.agent` →
built-in `"claude"`

The built-in `"claude"` fires only when every configured source is `undefined`. In
practice `global.agent` is always set in `config.json` (it is a required top-level
field in `fileSchema`), so the built-in is a last-resort safety net.

### Routing by job kind (opt-in)

`routing.{triage,spec,implement}` maps each job kind to a configured agent **name**,
top-level (global) or under `projects.<KEY>` (per-project wins). It sits between the
per-issue `meta` and the plain default agent in the cascade above, so a routed agent
beats `agent` but a CLI flag or per-issue label still overrides it. Absent
entries fall straight through — routing is fully opt-in and degrade-safe. Because
each agent carries its own `model` (see the `agents` map), routing a job kind to an
agent also routes its model.

## Run mode

`RunMode = "autonomous" | "supervised"`

**Precedence:** `cli.runMode` → `meta.runMode` → `project.runMode` →
`global.runMode` → built-in `"supervised"`

Same cascade shape as agent. The built-in fallback is `"supervised"`.

## Job kind

`JobKind = "triage" | "spec" | "implement"`

**Precedence:** `cli.jobKind` → `meta.jobKind` → `autoDetectJobKind(issue.type, issue.state.group)`

Unlike agent and run mode, jobKind has no project-level or global default. If neither
CLI nor meta supply a value, `autoDetectJobKind` in
[`src/resolve/jobkind.ts`](../src/resolve/jobkind.ts) derives it from the issue's
type and state group.

### autoDetectJobKind truth table

| Condition                              | Result      |
| -------------------------------------- | ----------- |
| `type === "Spike"` (any state group)   | `triage`    |
| `stateGroup === "backlog"` (non-Spike) | `spec`      |
| anything else                          | `implement` |

The type check runs first, so a Spike in `backlog` still yields `triage`. All
remaining state groups (`unstarted`, `started`, `completed`, `cancelled`) yield
`implement`.

## Repo

Resolution produces two values: `repo` (the config key) and `repoPath` (the
filesystem path).

**Precedence for the repo key:**
`cli.repo` → `meta.repo` → area-derived → `project.default_repo`

Area-derived uses only the **primary area** (first element of `issue.areas`):
`project.module_repo_map[areas[0]]`. If the issue has no areas, or the primary
area has no entry in [`module_repo_map`](config.md#projects), this slot is skipped.

If all four slots are `undefined`, beflow throws:

```
beflow: could not resolve a repo for this issue
```

Once a repo key is resolved, `repoPath` is looked up in `project.repos[repo]`.
If the key is not present there, beflow throws:

```
beflow: resolved repo "<key>" is not present in project.repos (known: <list>)
```

## Full resolution (`resolve`)

`resolve(inputs)` in [`src/resolve/precedence.ts`](../src/resolve/precedence.ts)
calls all four resolvers and returns a `Resolved` object:

```typescript
{
  agent: string;
  runMode: RunMode;
  jobKind: JobKind;
  repo: string;
  repoPath: string;
}
```

The four resolvers are independent; a failure in `resolveRepo` (the only one that
can throw) surfaces before the result is assembled.
