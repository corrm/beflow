import type { Issue, StateGroup } from "../../model/types.ts";
import { parseIssueMeta } from "../../resolve/metadata.ts";
import type { IntakeItem } from "../tracker.ts";
import type { RawIssue } from "./types.ts";

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

const PRIORITY_BY_NUMBER: Record<number, string> = {
    0: "none",
    1: "urgent",
    2: "high",
    3: "medium",
    4: "low",
};

export function mapPriority(n?: number): string | undefined {
    if (n === undefined) {
        return undefined;
    }
    return PRIORITY_BY_NUMBER[n];
}

const PRIORITY_BY_NAME: Record<string, number> = {
    high: 2,
    low: 4,
    medium: 3,
    none: 0,
    urgent: 1,
};

export function priorityToInt(priority?: string): number | undefined {
    if (priority === undefined) {
        return undefined;
    }
    const value = PRIORITY_BY_NAME[priority];
    if (value === undefined) {
        throw new Error(`linear: unknown priority "${priority}" (expected one of urgent|high|medium|low|none)`);
    }
    return value;
}

const VALID_STATE_GROUPS: ReadonlySet<StateGroup> = new Set<StateGroup>([
    "backlog",
    "unstarted",
    "started",
    "completed",
    "cancelled",
]);

function isStateGroup(type: string): type is StateGroup {
    return (VALID_STATE_GROUPS as ReadonlySet<string>).has(type);
}

export function mapStateType(type: string): StateGroup {
    if (type === "triage") {
        throw new Error(
            "linear: triage states are not queue states (triage issues arrive via listInbox, never as queue issues)",
        );
    }
    if (!isStateGroup(type)) {
        throw new Error(
            `linear: unsupported state type "${type}" (expected one of backlog|unstarted|started|completed|cancelled)`,
        );
    }
    return type;
}

export function mapIssue(raw: RawIssue): Issue {
    const labels = raw.labels.map((l) => l.name);
    const body = raw.description ?? "";
    return {
        archived: raw.archivedAt !== null && raw.archivedAt !== undefined,
        id: raw.id,
        key: raw.identifier,
        title: raw.title,
        body,
        // Linear has no native work-item type in this mapping; left undefined.
        type: undefined,
        state: { group: mapStateType(raw.state.type), name: raw.state.name },
        labels,
        // Linear has no modules; areas === labels so module_repo_map keyed by an
        // Area name still resolves a repo (DESIGN §3).
        areas: labels,
        priority: mapPriority(raw.priority),
        meta: parseIssueMeta(body, labels),
    };
}

export function mapIntakeItem(raw: RawIssue): IntakeItem {
    return {
        id: raw.id,
        // Linear has no numeric intake status; 0 stands for "in triage / pending".
        status: 0,
        title: raw.title,
        body: raw.description ?? "",
        issueId: raw.id,
        priority: mapPriority(raw.priority),
    };
}
