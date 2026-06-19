import type { Issue, StateGroup } from "../../model/types.ts";
import { parseIssueMeta } from "../../resolve/metadata.ts";
import type { IntakeItem } from "../tracker.ts";
import type { RawCycle, RawIntakeIssue, RawLabel, RawModule, RawState, RawWorkItem, RawWorkItemType } from "./types.ts";

const PRIORITY_RANK: Record<string, number> = {
    high: 1,
    low: 3,
    medium: 2,
    none: 4,
    urgent: 0,
};

export function priorityRank(priority?: string): number {
    if (priority === undefined) {
        return 4;
    }
    const rank = PRIORITY_RANK[priority];
    return rank ?? 4;
}

const VALID_STATE_GROUPS: ReadonlySet<StateGroup> = new Set<StateGroup>([
    "backlog",
    "unstarted",
    "started",
    "completed",
    "cancelled",
]);

function isStateGroup(group: string): group is StateGroup {
    return (VALID_STATE_GROUPS as ReadonlySet<string>).has(group);
}

export function mapStateGroup(group: string): StateGroup {
    if (!isStateGroup(group)) {
        throw new Error(
            `plane: unsupported state group "${group}" (expected one of backlog|unstarted|started|completed|cancelled; our board never uses triage states)`,
        );
    }
    return group;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toCommentHtml(text: string): string {
    return text
        .split(/\n{2,}/)
        .map((paragraph) => escapeHtml(paragraph).replace(/\n/g, "<br>"))
        .map((paragraph) => `<p>${paragraph}</p>`)
        .join("");
}

// Returns the first cycle currently in range. `todayIso` and the cycle dates are
// `YYYY-MM-DD` strings, for which lexicographic comparison is also chronological.
// A cycle missing either bound can't be confirmed active and is skipped.
export function pickActiveCycle(cycles: RawCycle[], todayIso: string): RawCycle | null {
    for (const cycle of cycles) {
        const { start_date, end_date } = cycle;
        if (start_date === undefined || start_date === null || end_date === undefined || end_date === null) {
            continue;
        }
        if (start_date <= todayIso && todayIso <= end_date) {
            return cycle;
        }
    }
    return null;
}

export function keyOf(identifier: string, sequenceId: number): string {
    return `${identifier}-${String(sequenceId)}`;
}

export interface MapContext {
    identifier: string;
    statesById: Map<string, RawState>;
    labelsById: Map<string, RawLabel>;
    modulesById: Map<string, RawModule>;
    typesById: Map<string, RawWorkItemType>;
}

function resolveState(raw: RawWorkItem, ctx: MapContext): { name: string; group: StateGroup } {
    const { state } = raw;
    if (state === undefined) {
        throw new Error(`plane: work item ${raw.id} has no state`);
    }
    if (typeof state === "object") {
        return { group: mapStateGroup(state.group), name: state.name };
    }
    const resolved = ctx.statesById.get(state);
    if (resolved === undefined) {
        throw new Error(`plane: cannot resolve state uuid "${state}" for work item ${raw.id}`);
    }
    return { group: mapStateGroup(resolved.group), name: resolved.name };
}

function resolveLabels(raw: RawWorkItem, ctx: MapContext): string[] {
    const labels = raw.labels ?? [];
    return labels.map((label) => {
        if (typeof label === "object") {
            return label.name;
        }
        const resolved = ctx.labelsById.get(label);
        if (resolved === undefined) {
            throw new Error(`plane: cannot resolve label uuid "${label}" for work item ${raw.id}`);
        }
        return resolved.name;
    });
}

function resolveAreas(raw: RawWorkItem, ctx: MapContext): string[] {
    // Plane's work-item serializer may omit module_ids; an empty/absent value
    // Yields []. Confirmed best-effort pending live verification.
    const moduleIds = raw.module_ids ?? [];
    return moduleIds.map((id) => {
        const resolved = ctx.modulesById.get(id);
        if (resolved === undefined) {
            throw new Error(`plane: cannot resolve module uuid "${id}" for work item ${raw.id}`);
        }
        return resolved.name;
    });
}

function resolveType(raw: RawWorkItem, ctx: MapContext): string | undefined {
    // Plane returns the type as a UUID (in `type`/`type_id`), not its name, and
    // Expand=state,labels does not expand it — so resolve the UUID → name via the
    // Types cache. A bare UUID would silently break mode auto-detect (Spike→triage).
    const type = raw.type ?? raw.type_id;
    if (type === undefined || type === null) {
        return undefined;
    }
    if (typeof type === "object") {
        return type.name;
    }
    return ctx.typesById.get(type)?.name;
}

export function mapWorkItem(raw: RawWorkItem, ctx: MapContext): Issue {
    const labels = resolveLabels(raw, ctx);
    const body = raw.description_stripped ?? "";
    return {
        archived: raw.archived_at !== null && raw.archived_at !== undefined,
        areas: resolveAreas(raw, ctx),
        body,
        id: raw.id,
        key: keyOf(ctx.identifier, raw.sequence_id),
        labels,
        meta: parseIssueMeta(body, labels),
        ...(raw.parent !== null && raw.parent !== undefined ? { parentId: raw.parent } : {}),
        priority: raw.priority,
        state: resolveState(raw, ctx),
        title: raw.name,
        type: resolveType(raw, ctx),
    };
}

export function mapIntakeItem(raw: RawIntakeIssue): IntakeItem {
    const detail = raw.issue_detail;
    return {
        body: detail.description_stripped ?? detail.description ?? "",
        id: raw.id,
        issueId: raw.issue,
        priority: detail.priority,
        status: raw.status,
        title: detail.name,
    };
}
