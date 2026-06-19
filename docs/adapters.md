# Writing a Tracker adapter

beflow talks to trackers through **one interface**. The adapter is the only
place in the codebase that imports a tracker-specific SDK or calls a tracker
API. beflow core — orchestration, agent dispatch, writeback — is
**tracker-blind**: it depends solely on the `Tracker` interface and the shared
model types in `src/model/types.ts`.

## The adapter boundary

```
beflow core  ──── Tracker interface ────  your adapter  ────  tracker API
```

Everything inside the left side knows nothing about Plane, Linear, or any
other tracker. Your adapter is the translation layer.

## The `Tracker` interface

Defined in [`src/trackers/tracker.ts`](../src/trackers/tracker.ts).

```ts
interface Tracker {
  // Issue retrieval
  getIssue(key: string): Promise<Issue>;
  blockedBy(issue: Issue): Promise<BlockerRef[]>;
  issueContext(issue: Issue): Promise<IssueContext>;

  // Issue mutation
  createIssue(project: string, draft: IssueDraft): Promise<Issue>;
  listQueue(filter: QueueFilter): Promise<Issue[]>;
  activeCycleIssueIds(project: string): Promise<Set<string> | null>;
  updateState(issue: Issue, stateName: string): Promise<void>;
  assign(issue: Issue, assigneeId: string): Promise<void>;
  addProperty(issue: Issue, name: string): Promise<void>;
  removeProperty(issue: Issue, name: string): Promise<void>;
  createProperty(project: string, name: string, opts?: { color?: string; description?: string }): Promise<void>;
  deleteProperty(project: string, name: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  listComments(issue: Issue): Promise<Comment[]>;
  linkPR(issue: Issue, url: string, title?: string): Promise<void>;
  readMetadata(issue: Issue): IssueMeta;

  // Inbox / triage
  listInbox(project: string): Promise<IntakeItem[]>;
  acceptInbox(project: string, item: IntakeItem): Promise<void>;

  // Board management
  inspectBoard(project: string): Promise<BoardState>;
  ensureBoard(project: string, template: BoardTemplate, opts?: EnsureBoardOptions): Promise<EnsureBoardResult>;
  createProject(spec: ProjectCreateSpec): Promise<ProjectCreateResult>;
}
```

### Method reference

**`getIssue(key)`** — Fetch one issue by its human key (e.g. `APP-42`).
Throw `IssueNotFoundError` when the key does not exist.

**`blockedBy(issue)`** — Return all `BlockerRef` entries that block this
issue. Each entry carries the blocker's key and a `done` flag that is `true`
when the blocker is in the `completed` or `cancelled` state group. Return `[]`
when the tracker does not support blocking relations.

**`issueContext(issue)`** — Return linked context to inline into the agent
task: the parent epic (`ParentContext`) and any file attachments
(`Attachment[]`). This method must degrade safely — if the tracker API returns
an error or the fields are absent, return `{ attachments: [], parent: undefined }`.

**`createIssue(project, draft)`** — Create a new work item in `project` (the
project key, e.g. `APP`) from the `IssueDraft` and return the fully-populated
`Issue`.

**`listQueue(filter)`** — Return all queued issues matching `QueueFilter`,
sorted priority-descending (urgent → high → medium → low → none). The `project`
field is the beflow project key. Optionally filter by `state` (exact state
name) or `stateGroup`.

**`activeCycleIssueIds(project)`** — Return the set of tracker-internal work
item IDs that belong to the project's currently active cycle/sprint, or `null`
when there is no active cycle, the concept does not exist in this tracker, or
the query fails.

**`updateState(issue, stateName)`** — Move `issue` to the state named
`stateName`. The state must already exist on the board; beflow does not create
states on the fly here.

**`assign(issue, assigneeId)`** — Assign `issue` to the given tracker user ID.

**`addProperty(issue, name)` / `removeProperty(issue, name)`** — Add or
remove a label (Plane label / Linear label) by name on `issue`. These are the
single-item label-mutation primitives that beflow calls for lifecycle signals
(e.g. `changes-requested`).

**`createProperty(project, name, opts)` / `deleteProperty(project, name)`** —
Create or delete a label in `project` at the tracker level (not per-issue).
`opts` carries optional `color` and `description`.

**`comment(issue, body)`** — Post a comment on `issue`. Append the beflow
marker (`withMarker(body)` from `src/trackers/marker.ts`) so `listComments`
can set `isBot: true` on returned comments.

**`listComments(issue)`** — Return all comments on `issue` as `Comment[]`.
Set `isBot: true` on any comment whose body contains the string `— beflow`
(the `hasMarker` helper in `src/trackers/marker.ts`).

**`linkPR(issue, url, title?)`** — Attach a pull-request URL to `issue`.
Use whatever mechanism the tracker provides (a work item link, a PR relation,
etc.).

**`readMetadata(issue)`** — Parse per-issue beflow overrides out of the
already-fetched `Issue`. Delegate to `parseIssueMeta` from
`src/resolve/metadata.ts`, which reads the `<!-- beflow … -->` body block and
`agent:` / `run:` / `repo:` / `jobkind:` labels. Your adapter supplies the
already-normalized `body` and `labels`; no raw API call is needed here.

**`listInbox(project)`** — Return all pending intake/triage items for
`project`. For Plane this is the Intake queue; for Linear this is the Triage
inbox.

**`acceptInbox(project, item)`** — Accept/promote an intake item into the
main project work list.

**`inspectBoard(project)`** — Return the current set of states, labels,
modules, and work-item types that exist in `project` as `BoardState`.

**`ensureBoard(project, template, opts?)`** — Reconcile the board against
`template`, creating or updating missing entities. This operation must be
idempotent: entities that already match the template go into `skipped`;
newly-created ones go into `created`; patched-in-place ones go into `updated`.
Use `warnings` for features that cannot be set via the API (e.g. a
workspace-level toggle). When `opts.prune` is true, also delete orphan entities
(those present in the tracker but absent from the template) and record them in
`pruned`. When `opts.resolveModuleChanges` is provided, call it with the
`ModuleChange` diff before pruning modules so the caller can rename instead of
delete. Called by [`beflow setup`](commands.md#setup-project--update-project).

**`createProject(spec)`** — Create a new project from `ProjectCreateSpec`.
Return `ProjectCreateResult`, which carries the tracker-internal project ID in
`trackerProjectId` when applicable.

## Shared model types

All types an adapter maps to/from live in `src/model/types.ts` and
`src/trackers/tracker.ts`.

### `Issue`

```ts
interface Issue {
  id: string; // tracker-internal UUID
  key: string; // human identifier, e.g. "APP-42"
  title: string;
  body: string;
  type?: string; // work-item type name, e.g. "Bug", "Feature"
  state: { name: string; group: StateGroup };
  labels: string[]; // label names
  areas: string[]; // code areas — Plane "modules" / Linear "labels"
  priority?: string; // "urgent" | "high" | "medium" | "low" | "none"
  parentId?: string; // tracker-internal ID of the parent item
  meta: IssueMeta;
  archived?: boolean;
}
```

`areas` drives repo resolution via [`module_repo_map`](config.md#projects) in
`config.json`'s `projects.<KEY>`.

### `StateGroup`

```ts
type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
```

Map your tracker's statuses onto this five-value enum. beflow's default board
uses: `Backlog` → `backlog`, `Todo` → `unstarted`, `In Progress` → `started`,
`Needs Input` → `started`, `In Review` → `started`, `Done` → `completed`,
`Cancelled` → `cancelled`. See [lifecycle.md](lifecycle.md) for the full board state reference.

### `IssueMeta`

```ts
interface IssueMeta {
  agent?: string;
  repo?: string;
  runMode?: "autonomous" | "supervised";
  jobKind?: "triage" | "spec" | "implement";
}
```

Parsed from the issue body and labels by `parseIssueMeta`. Your adapter does
not need to produce this; just ensure `body` and `labels` are faithfully mapped.

### `Comment`

```ts
interface Comment {
  id: string;
  body: string;
  createdAt: string;
  isBot: boolean;
  authorId?: string;
}
```

### `BlockerRef`

```ts
interface BlockerRef {
  key: string; // e.g. "APP-5"
  done: boolean; // true when blocker is completed or cancelled
}
```

### `IssueContext`, `Attachment`, `ParentContext`

```ts
interface IssueContext {
  attachments: Attachment[];
  parent?: ParentContext;
}

interface Attachment {
  name: string;
  url: string;
}

interface ParentContext {
  body: string;
  key: string;
  title: string;
  type?: string;
}
```

### `IssueDraft`

```ts
interface IssueDraft {
  title: string;
  body: string; // passed through as-is; no markdown→HTML conversion
  type?: string; // work-item type name, e.g. "Bug"
  priority?: string; // "urgent" | "high" | "medium" | "low" | "none"
  labels?: string[]; // label names
  assigneeId?: string; // tracker user ID
  state?: string; // state name; omitted means the tracker's default
}
```

### `QueueFilter`

```ts
interface QueueFilter {
  project: string; // beflow project key, e.g. "APP"
  state?: string; // exact state name, e.g. "Todo"
  stateGroup?: StateGroup; // OR filter by group
}
```

### `IntakeItem`

```ts
interface IntakeItem {
  id: string; // intake-issue ID
  status: number; // tracker status code (e.g. Plane: 1 = accepted)
  title: string;
  body: string;
  issueId: string; // the wrapped work item ID
  priority?: string;
}
```

### `BoardTemplate` and `BoardState`

```ts
interface BoardTemplate {
  states: { name: string; color: string; group: StateGroup; sequence?: number }[];
  types: { name: string; description?: string }[];
  labels: { name: string; color?: string; description?: string }[];
  modules: { name: string; description?: string }[];
}

interface BoardState {
  states: string[];
  labels: string[];
  modules: string[];
  types: string[];
}
```

### `EnsureBoardResult` and `EnsureBoardOptions`

```ts
interface EnsureBoardResult {
  created: string[]; // e.g. "state:In Review"
  updated: string[]; // existed but a tracked property drifted and was patched
  skipped: string[]; // already existed and matched
  warnings: string[]; // e.g. work-item-types feature toggle is off
  orphans: string[]; // present in tracker but absent from template
  pruned: string[]; // orphans actually deleted this run (prune mode only)
}

interface EnsureBoardOptions {
  prune?: boolean;
  resolveModuleChanges?: ResolveModuleChanges;
}
```

### `ProjectCreateSpec` and `ProjectCreateResult`

```ts
interface ProjectCreateSpec {
  identifier: string; // project key, e.g. "APP"
  name: string;
  description?: string;
}

interface ProjectCreateResult {
  trackerProjectId?: string; // tracker-internal UUID, when applicable
}
```

## Bot-comment attribution

beflow distinguishes its own comments from human comments. The marker module
(`src/trackers/marker.ts`) owns this convention:

- **Posting**: call `withMarker(body)` before passing the string to your
  tracker's comment API. This appends `\n\n— beflow` to the body.
- **Detecting**: in `listComments`, set `isBot: true` on any comment whose
  body contains `— beflow` (`hasMarker(body)`).
- **Stripping**: `stripMarker(body)` removes the suffix for display purposes.

This marker is tracker-agnostic. Both the Plane and Linear adapters use the
same helpers.

## Project key mapping

beflow is multi-project. The `config.json` `projects` map is keyed by the
beflow project key (e.g. `APP`). How that key maps to a tracker-native ID
is adapter-specific:

- **Plane**: the project key equals the Plane project `identifier` field
  (the short uppercase slug shown on every issue). The adapter resolves the
  Plane project UUID from `plane_project_id` in the project config entry.
- **Linear**: the project key maps to a Linear team. The adapter holds an
  in-memory cache of teams indexed by key; the key is matched against the
  Linear team's `key` field.

When writing a new adapter, decide at construction time how to resolve
`project` (the beflow key) to your tracker's internal project/workspace
concept, and cache that mapping.

## Recommended file layout

Mirror the layout of `src/trackers/plane/` or `src/trackers/linear/`.
Create `src/trackers/<name>/`:

| File         | Responsibility                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`   | Raw API shapes returned by the tracker SDK or REST API.                                                                                                     |
| `map.ts`     | **Pure** functions: raw shapes ↔ normalized `Issue` / `IntakeItem` / etc. No I/O — unit-test these in isolation.                                            |
| `client.ts`  | HTTP/SDK gateway: authentication, pagination, rate-limit handling. Reads credentials from the env var named by `config.json`'s `trackers.<name>.apiKeyEnv`. |
| `adapter.ts` | The `Tracker` implementation. Receives the client as a constructor injection so tests can pass a fake. Delegates shape translation to `map.ts`.             |

Keep **all** tracker I/O in the client and **all** shape translation in the
mapper. The adapter wires them together and holds no raw API types.

## Registering the adapter in the factory

[`src/trackers/factory.ts`](../src/trackers/factory.ts) exports a single
function:

```ts
export function createTracker(config: Config, registry: Registry, env: NodeJS.ProcessEnv): Tracker {
  switch (config.tracker) {
    case "plane":
      return createPlaneTracker(config, registry, env);
    case "linear":
      return createLinearTracker(config, registry, env);
    default: {
      const exhaustive: never = config.tracker;
      throw new Error(`unknown tracker "${String(exhaustive)}"`);
    }
  }
}
```

To add a new tracker:

1. Add the tracker name to the `tracker` enum in `src/config/schema.ts`:

   ```ts
   tracker: z.enum(["plane", "linear", "mytracker"]),
   ```

2. Add a `trackers.mytracker` sub-schema in `fileSchema` for any
   adapter-specific config (e.g. `apiKeyEnv`, `baseUrl`).

3. Implement `createMyTracker(config, registry, env): Tracker` in
   `src/trackers/mytracker/adapter.ts`.

4. Add the case to the `switch` in `factory.ts`:
   ```ts
   case "mytracker": return createMyTracker(config, registry, env);
   ```

The TypeScript exhaustive-check on `default` will produce a compile error if
you add the enum value but forget the `case`, making the wiring impossible to
miss.

## Golden rule

**Never expose the tracker to the agent.** beflow is the sole tracker writer;
the agent receives a task, a repository path, and a contract, then returns a
`beflow-report`. Adding a tracker adapter must require **zero** agent changes —
that is the entire point of this seam.
