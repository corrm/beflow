# Picking properties for an issue

A quick guide to overriding `agent`, `jobKind`, `runMode`, and `repo` on a
single issue without touching your global config. For the full priority order
and builtin defaults, see the [unified resolution reference](resolution.md#unified-resolution-reference).

---

## How to set a property on one issue

There are two mechanisms: **labels** and **body-meta blocks**. Labels work on
every tracker; body-meta blocks work only on trackers that preserve the
description (e.g. Linear — see the caveat below).

### Labels

Attach a label of the form `key:value` to the issue. Recognised keys and their
label syntax:

| Property  | Label syntax     | Example          |
| --------- | ---------------- | ---------------- |
| `agent`   | `agent:<name>`   | `agent:claude`   |
| `jobKind` | `jobkind:<kind>` | `jobkind:triage` |
| `runMode` | `run:<mode>`     | `run:autonomous` |
| `repo`    | `repo:<key>`     | `repo:website`   |

Note the label key for `runMode` is `run` (not `runMode`), and for `jobKind`
it is `jobkind` (lowercase, no capital K).

### Body-meta block

An HTML comment anywhere in the issue description:

```
<!-- beflow
agent: claude
repo: website
runMode: autonomous
jobKind: spec
-->
```

Recognised keys inside the block: `agent`, `repo`, `runMode`, `jobKind`.

When both a label and a body-meta block set the same field, the **body-meta
block wins** (body overrides label on conflict).

> **Plane caveat:** Plane's description editor strips HTML comments on save, so
> the `<!-- beflow ... -->` body-meta block does not survive and is ignored. On
> Plane, labels are the only per-issue mechanism. The body-meta > label
> precedence only applies on trackers that preserve the description (e.g.
> Linear).

---

## What each property falls back to when unset

| Property  | Fallback when no CLI flag, label, or body-meta sets it                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `agent`   | `project.routing[jobKind]` → `project.agent` → `global.agent` → `"claude"`                                |
| `jobKind` | Auto-detected from issue type + state group (Spike → `triage`; backlog → `spec`; otherwise → `implement`) |
| `runMode` | `project.runMode` → `global.runMode` → `"supervised"`                                                     |
| `repo`    | Area-derived from `module_repo_map` → `project.default_repo` → **error** if still unresolved              |

Selectable job kinds are `triage`, `spec`, and `implement` only. `review` is a
separate command (`beflow review <key>`), not a job kind.

---

## Examples

### Route one spike to a lighter agent

You have a Spike issue that auto-detects to `triage` but you want a specific
agent instead of the project default:

```
Label: agent:haiku
```

The label sets `meta.agent`, which beats `project.routing[triage]` and
`project.agent` in the cascade.

### Force an issue into a different repo

Your issue has no module set (or its module is not in `module_repo_map`) so
it would fall back to `project.default_repo`. Override it:

```
Label: repo:website
```

beflow skips area-derived resolution and the `default_repo` fallback because
`meta.repo` is now set and wins earlier in the cascade.

### Run one backlog item autonomously

Backlog issues auto-detect to `spec`, which you normally run supervised. For
one well-specified item you want an autonomous run:

```
Label: run:autonomous
```

`meta.runMode` beats `project.runMode` and `global.runMode`.

---

## Full precedence

The complete priority order for every resolved property — including `pr.owner`,
`pr.baseBranch`, `policy.evaluator`, and `policy.onBlock` — is in the
[unified resolution reference table](resolution.md#unified-resolution-reference).
