# Linear SDK — beflow adapter reference

Ground-truth the `LinearTracker` adapter is built against, captured from
`@linear/sdk` v86 (2026-06-14). The SDK is used ONLY inside `LinearSdkGateway`
(`client.ts`); the adapter + mappers depend on the `LinearGateway` interface so
tests need no SDK and never hit the network.

## Connection

- `new LinearClient({ apiKey })`. API key from `env[config.trackers.linear.apiKeyEnv]`.

## Issues

- `client.issue(idOrIdentifier)` → `Issue` with:
  - `id`, `identifier` (human key, e.g. `"ENG-42"`), `title`,
    `description` (markdown, may be undefined),
  - `priority` (NUMBER: `0` none, `1` urgent, `2` high, `3` medium, `4` low),
  - `state` — a Promise → `WorkflowState` (`name`, `type`),
  - `labels()` — a Promise → connection; names at `.nodes[].name`,
  - `team` — a Promise → `Team` (`id`, `key`).
- `WorkflowState.type` ∈ `backlog|unstarted|started|completed|cancelled|triage`.
  Maps directly onto our `StateGroup`; `triage` is Linear's intake (see Inbox) —
  `mapStateType` throws on it.
- `client.issues({ filter, first })` → connection: `.nodes`,
  `.pageInfo.hasNextPage`, `.fetchNext()`.
  - Filter by team + state, e.g.
    `{ team: { key: { eq } }, state: { name: { eq } } }` or `state: { type: { eq } }`.

## Mutations (v86 names)

- `client.updateIssue(id, { stateId })` — state change.
- `client.updateIssue(id, { labelIds })` — REPLACE-set (include existing + new).
- `client.createComment({ issueId, body })` — `body` is markdown, passed through.
- `client.createAttachment({ issueId, url, title })` — used for the PR link.
- `client.createIssue({ teamId, title, description?, stateId })`.
- `client.createWorkflowState({ teamId, name, type, color })`.
- `client.createIssueLabel({ teamId, name, color })`.

NOTE: older SDK docs name these `issueUpdate` / `commentCreate` /
`attachmentCreate` / `issueCreate` / `workflowStateCreate` / `issueLabelCreate`.
v86 renamed them to the `update*` / `create*` forms above; the gateway uses v86.

## States / labels for a team

- `client.teams({ filter: { key: { eq } } })` → connection; `.nodes[0].id` is the
  team id (cached by the gateway).
- `team.states()` → connection of `{ id, name, type }`.
- `team.labels()` → connection of `{ id, name }`.
- Workspace-wide alternatives: `client.workflowStates()`, `client.issueLabels()`.

## Triage inbox

- Triage inbox = issues whose state `type === 'triage'`
  (`listIssues` filtered by `state: { type: { eq: 'triage' } }`).
- `acceptInbox` moves such an issue to the team's first `backlog`-type state via
  `updateIssue(id, { stateId })`.

## No modules / no work-item types

Linear has no modules or work-item-type equivalent. `mapIssue` sets
`areas === labels` (DESIGN §3) and leaves `type` undefined. `ensureBoard` pushes
`warnings` for the `modules`/`types` parts of the template instead of failing.

## Relations / comments / label deletion

- `issue.inverseRelations()` → connection; for each node where `type === "blocks"`,
  the SOURCE issue (`node.issue`) is the blocker and `node.relatedIssue` is this
  issue. `getBlockers` reads each source's `state.type` so `blockedBy` can flag
  `completed`/`cancelled` blockers as `done`.
- `issue.comments()` → `CommentConnection`; nodes carry `body` (markdown),
  `createdAt` (Date), and `user` (Promise → `User`, null for bot/integration
  comments). `listComments` strips the beflow marker and flags marked bodies as bot.
- `client.deleteIssueLabel(id)` → `DeletePayload` (awaited, ignored) backs
  `deleteProperty`.

## Parity status

IMPLEMENTED for Linear (against the SDK types, not yet live-verified):
`getIssue` not-found discrimination, `blockedBy`, `listComments`, `inspectBoard`
(states + labels; empty modules/types), and `deleteProperty`.

The not-found check is a **message heuristic** (`/not found|could not find|entity
not found/i`) because the SDK exposes no stable not-found discriminator.

Remaining intentional gaps (safe degradations, tracked under Linear parity):

- `issueContext` — parent epic + attachments not wired; returns `{ attachments: [] }`.
- `activeCycleIssueIds` — cycle-aware scheduling Plane-only; returns `null`.
- `ensureBoard` — create-only; no reconcile (update-drifted) or prune/orphan
  detection yet.
