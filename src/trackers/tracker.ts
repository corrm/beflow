import type { Issue, IssueMeta, StateGroup } from "../model/types.ts";

export class IssueNotFoundError extends Error {
    public constructor(public readonly key: string) {
        super(`beflow: work item "${key}" not found`);
        this.name = "IssueNotFoundError";
    }
}

export interface Comment {
    id: string;
    body: string;
    createdAt: string;
    isBot: boolean;
    authorId?: string;
}

export interface BlockerRef {
    key: string; // the blocking issue's key, e.g. "CG-5"
    done: boolean; // true when the blocker is in the completed OR cancelled state group
}

export interface Attachment {
    name: string;
    url: string;
}

export interface ParentContext {
    body: string;
    key: string;
    title: string;
    type?: string;
}

export interface IssueContext {
    attachments: Attachment[];
    parent?: ParentContext;
}

export interface QueueFilter {
    project: string; // Project KEY e.g. "CG" (matches registry key === Plane project identifier)
    state?: string; // Filter by exact state name, e.g. "Todo"
    stateGroup?: StateGroup; // OR filter by group
}

export interface IssueDraft {
    title: string;
    body: string; // Mapped to Plane description_html as a passthrough string (format-agnostic — no markdown→HTML conversion here)
    type?: string; // Work-item type NAME (e.g. "Bug")
    priority?: string; // urgent|high|medium|low|none
    labels?: string[]; // Label NAMES
    assigneeId?: string; // Tracker user id (uuid)
    state?: string; // State NAME; omitted ⇒ tracker default state
}

export interface IntakeItem {
    id: string; // Intake-issue id
    status: number; // Plane intake status code (1 = accepted, etc.)
    title: string;
    body: string;
    issueId: string; // The wrapped work item id
    priority?: string;
}

export interface BoardTemplate {
    states: { name: string; color: string; group: StateGroup; sequence?: number }[];
    types: { name: string; description?: string }[];
    labels: { name: string; color?: string; description?: string }[];
    modules: { name: string; description?: string }[];
}

export interface BoardState {
    states: string[];
    labels: string[];
    modules: string[];
    types: string[];
}

export interface ProjectCreateSpec {
    description?: string;
    identifier: string;
    name: string;
}

export interface ProjectCreateResult {
    trackerProjectId?: string;
}

export interface EnsureBoardResult {
    created: string[]; // E.g. "state:In Review"
    updated: string[]; // Existed but a tracked property drifted and was PATCHed
    skipped: string[]; // Already existed and matched (by name + tracked properties)
    warnings: string[]; // E.g. work-item-types feature toggle is off
    orphans: string[]; // E.g. "module:OldName" — exists in Plane but not in template
    pruned: string[]; // Orphans actually deleted this run (only when prune is on)
}

export interface EnsureBoardOptions {
    prune?: boolean;
    resolveModuleChanges?: ResolveModuleChanges;
}

export interface ModuleChange {
    removed: string[]; // orphan module names: present in the tracker, absent from config
    added: string[]; // template module names not yet present in the tracker
}

export type ModuleChangeAction = { kind: "rename"; to: string } | { kind: "remove" } | { kind: "keep" };

export type ResolveModuleChanges = (change: ModuleChange) => Promise<Record<string, ModuleChangeAction>>;

export interface Tracker {
    getIssue(key: string): Promise<Issue>;
    blockedBy(issue: Issue): Promise<BlockerRef[]>; // the issues that BLOCK this one (its blocked_by relations), tagged with whether each is resolved
    issueContext(issue: Issue): Promise<IssueContext>; // linked context (parent epic + attachments) to inline into the agent task; degrade-safe

    createIssue(project: string, draft: IssueDraft): Promise<Issue>; // create a work item from a draft; returns the created Issue fully populated
    listQueue(filter: QueueFilter): Promise<Issue[]>; // Returned priority-ranked (urgent→none)
    activeCycleIssueIds(project: string): Promise<Set<string> | null>; // work-item ids in the project's active cycle, or null when none is determinable (no active cycle, unsupported, or error)
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
    listInbox(project: string): Promise<IntakeItem[]>;
    acceptInbox(project: string, item: IntakeItem): Promise<void>;
    inspectBoard(project: string): Promise<BoardState>;
    ensureBoard(project: string, template: BoardTemplate, opts?: EnsureBoardOptions): Promise<EnsureBoardResult>;
    createProject(spec: ProjectCreateSpec): Promise<ProjectCreateResult>;
    findProjectId(identifier: string): Promise<string | null>; // the tracker's project id for an existing project with this identifier, or null when none exists; no network-free guarantee, but never creates
    verifyAuth(): Promise<void>; // cheap auth probe; resolves when the token is valid, throws a clear, actionable error otherwise
}
