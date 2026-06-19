# Plane Cloud REST API — beflow adapter reference

Captured from https://developers.plane.so/api-reference (2026-06-14). This is the
ground-truth the `PlaneTracker` adapter is built against. Self-hosted instances
use a different base URL but the same paths.

## Connection

- **Base URL**: `https://api.plane.so` — prefix every path with `/api/v1`.
- **Auth**: header `X-API-Key: <personal token>`. (OAuth `Authorization: Bearer`
  also works but beflow uses the API key.)
- **Content-Type**: `application/json`.
- **Rate limit**: 60 requests / minute / key. Reset every minute.

## Pagination (cursor-based)

List responses are wrapped:

```json
{ "next_cursor": "20:1:0", "prev_cursor": "", "next_page_results": true,
  "prev_page_results": false, "count": 20, "total_pages": 50,
  "total_results": 1000, "extra_stats": {}, "results": [ ... ] }
```

Pass `?cursor=<next_cursor>&per_page=100` to page. `per_page` max = 100.
Keep fetching while `next_page_results` is true.

## Work items (issues)

Project-scoped base: `/api/v1/workspaces/{slug}/projects/{project_id}/work-items`

- **List**: `GET .../work-items/?expand=state,labels&per_page=100&cursor=…&order_by=…`
  - query: `cursor`, `expand` (csv), `fields` (csv), `order_by` (prefix `-` desc), `per_page`.
  - NOTE: the plain list endpoint does **not** filter by state-group/priority.
    beflow lists with `expand=state,labels`, then filters + ranks client-side.
- **Get by UUID**: `GET .../work-items/{resource_id}/?expand=state,labels`
- **Get by human key** (resolves `CG-42`): workspace-level, no project in path —
  `GET /api/v1/workspaces/{slug}/work-items/{project_identifier}-{sequence_id}/`
  e.g. `…/work-items/CG-42/`. Supports `expand`.
- **Create**: `POST .../work-items/` body `{ name (req), description_html?, priority?,
state? (uuid), labels? (uuid[]), assignees? (uuid[]), type_id? }`
- **Update**: `PATCH .../work-items/{resource_id}/` same body fields, all optional.
  - **State change** = `{ "state": "<state-uuid>" }` (field name is `state`, value is the UUID).

### Work-item fields used by beflow

`id` (uuid), `name` (→ title), `description_html` / `description_stripped` (→ body),
`sequence_id` (int; human key = `{project.identifier}-{sequence_id}`),
`priority` (`urgent|high|medium|low|none`), `state` (uuid, or object when expanded),
`labels` (uuid[], or object[] when expanded), `type_id` / type name,
`module_ids` (uuid[] when present → areas; absent ⇒ no areas),
**VERIFIED (2026-06-18):** `type` / `type_id` come back as literal `null` (not absent) when
the project has **issue-types disabled**; the mapper guards `=== null` as well as
`=== undefined` (a bare `typeof null === "object"` check would otherwise throw and crash
`getIssue` for every item on a typeless project), yielding `Issue.type === undefined`.
`parent` (uuid, or `null`/absent when top-level → `Issue.parentId`; used to fetch the
parent epic for linked context). **VERIFIED (2026-06-17, MCP):** unexpanded `parent` is a
uuid or `null`; with `?expand=parent` an item with no parent returns `{}` (empty object).
beflow does NOT expand parent, so the `raw.parent ?? undefined` mapping is correct.

## Attachments (linked context)

`GET .../work-items/{work_item_id}/attachments/` — beflow reads each attachment's `name`
(+ download URL when present) to inline as linked context for a headless agent. **VERIFIED
(2026-06-18, end-to-end):** the list exposes a top-level `name` **plus** `attributes.name`,
and an `asset` (the S3 object path) but **NO inline `asset_url` / download URL** — that is a
SEPARATE call (`get_work_item_attachment_download_url`). beflow's lenient shape
`{ id, name?, asset_url?, attributes?: { name? } }` reads the name from `name` (or legacy
`attributes.name`) and keeps the NAMED attachment with an **empty url** (so the agent at
least knows it exists), drops only nameless entries, and fails closed (404 / unexpected ⇒
`[]`). Confirmed against a real attachment.

## Comments

`POST .../work-items/{work_item_id}/comments/` body `{ comment_html: "<p>…</p>" }`
(also `comment_json`, `access` INTERNAL|EXTERNAL). beflow sends `comment_html`.

## Links (used for PR link)

`POST .../work-items/{work_item_id}/links/` body `{ url (req), title? }`.
Response: `{ id, url, title, metadata, ... }`.

## Intake (native triage inbox)

- **List**: `GET .../intake-issues/?expand=…` → paginated; each result wraps an
  issue: `{ id, status, source, issue: { id, name, description, priority,
sequence_id, … }, created_at, … }`.
- **Create**: `POST .../intake-issues/` body `{ issue: { name (req), description?, priority? } }`.
- **Update / accept** (**VERIFIED 2026-06-18**): status updates use a dedicated
  sub-resource with the **issue id** (NOT the intake record id):
  `PATCH .../intake-issues/{issue_id}/status/` body `{ status }` where
  `status`: `-2` Pending, `-1` Rejected, `0` Snoozed, `1` Accepted, `2` Duplicate.
  Accepting (`status: 1`) promotes it to a normal work item.
  NOTE: `PATCH .../intake-issues/{id}/` (without `/status/`) rejects status changes
  with HTTP 400 `{"error":"Use the intake status endpoint to update status, …"}`.
  The intake record id (`item.id`) and the inner issue id (`item.issueId`) differ;
  the status endpoint requires the issue id.

## States (board columns)

- **List**: `GET .../states/` → `{ results: [{ id, name, group, color, sequence,
is_triage, default, … }] }`. `group`: `backlog|unstarted|started|completed|
cancelled|triage`.
- **Create**: `POST .../states/` body `{ name (req), color (req), group?, sequence?,
description?, is_triage?, default? }`.

## Labels

- **List**: `GET .../labels/`. **Create**: `POST .../labels/` body `{ name (req),
color?, description? }`.

## Modules (= code areas)

- **List**: `GET .../modules/` → `{ results: [{ id, name, description, status, … }] }`.
- **Create**: `POST .../modules/` body `{ name (req), description?, status? }`
  (`status`: `backlog|planned|in-progress|paused|completed|cancelled`).
- **Assign work items**: `POST .../modules/{module_id}/module-issues/`
  body `{ issues: [<work_item_uuid>] }`.

## Work-item types (Bug/Feature/Chore/Spike)

- **List**: `GET .../work-item-types/`. **Create**: `POST .../work-item-types/`
  body `{ name (req), description? }`.
- **Caveat**: types require the workspace-level **Work Item Types** feature toggle,
  which is **not** settable via API. If creation 4xxs because the feature is off,
  `ensureBoard` must surface a "flip this UI toggle" instruction, not fail silently.

## Cycles (= sprints, for cycle-aware scheduling)

Used by opt-in cycle-aware scheduling (`projects.<KEY>.scheduling.activeCycleOnly`) to
narrow Todo dispatch to the work items in the project's **active cycle**.

- **List cycles**: `GET .../cycles/` → paginated; item shape
  `{ id, name?, start_date?, end_date? }`. **VERIFIED (2026-06-18):** `start_date` /
  `end_date` come back as **full ISO datetimes** (e.g. `2026-06-16T00:00:01+03:00`), **not**
  bare `YYYY-MM-DD`. The active cycle is the one whose `start_date <= today <= end_date`;
  beflow compares them as plain strings against a `YYYY-MM-DD` `today`, and because the ISO
  datetime is lexicographically prefixed by its date the comparison stays correct.
- **List a cycle's work items (membership)**: **VERIFIED (2026-06-18):** the correct path is
  `GET .../cycles/{cycle_id}/cycle-issues/` → paginated. The previously assumed
  `cycle-work-items/` name **404s** ("Page not found"). Each result **IS a full work item**,
  so its `id` is the work-item uuid (`{ id, name, description_html, … }`). beflow's lenient
  membership shape `{ id?, work_item? }` reads `work_item ?? id`; since `cycle-issues/` rows
  carry no `work_item` field, the `id` fallback already yields the right uuid.
- **Degrade-safe**: the adapter wraps both calls and fails closed (no active cycle, an
  unsupported endpoint, or any fetch error ⇒ `null` ⇒ dispatch without a cycle filter), so
  a wrong shape can never halt the pipeline. Estimate/capacity scheduling is out of scope.
