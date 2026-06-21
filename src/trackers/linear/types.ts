// Plain, already-resolved shapes the Linear gateway returns to the adapter +
// Pure mappers. The SDK exposes state/labels/team as Promises; the gateway
// Awaits them and hands back these flat objects so map.ts stays sync + pure.

export interface RawWorkflowState {
    id: string;
    name: string;
    type: string; // Backlog|unstarted|started|completed|cancelled|triage
}

export interface RawLabel {
    id: string;
    name: string;
}

export interface RawTeam {
    id: string;
    key: string;
}

export interface RawComment {
    authorId?: string;
    body: string;
    createdAt: string; // ISO
    id: string;
}

export interface RawBlocker {
    identifier: string;
    stateType: string; // workflow state type: completed/cancelled ⇒ done
}

export interface RawAttachment {
    id: string;
    url: string;
    title: string;
}

// A Linear issue with its async sub-fields already resolved by the gateway.
export interface RawIssue {
    id: string;
    identifier: string; // Human key, e.g. "ENG-42"
    title: string;
    description?: string; // Markdown, may be undefined
    priority?: number; // 0 none, 1 urgent, 2 high, 3 medium, 4 low
    state: RawWorkflowState;
    labels: RawLabel[];
    team: RawTeam;
    archivedAt?: string | null; // ISO timestamp when archived; null/absent means active
}
