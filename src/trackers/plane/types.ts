export interface RawProject {
    id: string;
    identifier?: string;
}

export interface RawUser {
    id: string;
    email?: string;
    display_name?: string;
}

export interface Paginated<T> {
    next_cursor: string;
    prev_cursor: string;
    next_page_results: boolean;
    prev_page_results: boolean;
    count: number;
    total_pages: number;
    total_results: number;
    results: T[];
}

export interface RawState {
    id: string;
    name: string;
    group: string;
    color: string;
    sequence?: number;
    is_triage?: boolean;
    default?: boolean;
}

export interface RawLabel {
    id: string;
    name: string;
    color?: string;
    description?: string;
}

export interface RawModule {
    id: string;
    name: string;
    description?: string;
    status?: string;
}

export interface RawWorkItemType {
    id: string;
    name: string;
    description?: string;
}

export interface RawWorkItem {
    id: string;
    name: string;
    sequence_id: number;
    description_html?: string;
    description_stripped?: string;
    priority?: string;
    // State is a uuid string, or an expanded object when ?expand=state.
    state?: string | RawState;
    // Labels are uuid strings, or expanded objects when ?expand=labels.
    labels?: (string | RawLabel)[];
    module_ids?: string[];
    // Parent work item uuid (epic or grouping item); null/absent when top-level.
    parent?: string | null;
    // `null` on a project with issue-types disabled (live shape); the mapper guards it.
    type_id?: string | null;
    // Type may be expanded to an object carrying its name; `null` when types are disabled.
    type?: string | { id: string; name: string } | null;
    // Set when the work item has been archived; null/absent means active.
    archived_at?: string | null;
}

// Plane attachment shape, reconciled against the live MCP surface (2026-06-17):
// the list exposes a top-level `name` (older builds nest it under `attributes`);
// the download URL is a SEPARATE call, so `asset_url` is frequently absent. Every
// field is optional; the adapter keeps any named attachment (URL or not).
export interface RawAttachment {
    id: string;
    asset_url?: string;
    name?: string;
    attributes?: { name?: string };
}

export interface RawIntakeIssue {
    id: string;
    issue: string;
    issue_detail: {
        id: string;
        name: string;
        description?: string;
        description_stripped?: string;
        priority?: string;
        sequence_id?: number;
    };
    source?: string;
    status: number;
}

// The work-item relations endpoint groups related work items by relation type,
// each group being a bare array of work-item UUIDs (NOT expanded objects). We
// only consume blocked_by; the other groups are declared for shape fidelity.
export interface RawWorkItemRelations {
    blocking?: string[];
    blocked_by?: string[];
    duplicate?: string[];
    relates_to?: string[];
    start_after?: string[];
    start_before?: string[];
    finish_after?: string[];
    finish_before?: string[];
}

// Plane's cycles endpoints are UNVERIFIED against our live API notes, so every
// Field is optional/tolerant and the adapter fails closed on any fetch error.
export interface RawCycle {
    id: string;
    name?: string;
    start_date?: string | null;
    end_date?: string | null;
}

export interface RawCycleWorkItem {
    id?: string;
    work_item?: string;
}

export interface RawComment {
    id: string;
    comment_html?: string;
    created_at?: string;
    created_by?: string;
    comment_stripped?: string;
}

export interface RawLink {
    id: string;
    url: string;
    title?: string;
}
