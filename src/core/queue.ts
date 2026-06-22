import { assertKnownProject } from "../config/registry.ts";
import type { Registry } from "../config/schema.ts";
import type { Tracker } from "../trackers/tracker.ts";

export interface QueueRow {
    project: string;
    key: string;
    title: string;
    state: string;
    priority?: string;
}

export interface QueueDeps {
    tracker: Tracker;
    registry: Registry;
}

export interface QueueOptions {
    projects?: string[];
    state?: string;
}

export async function queueView(deps: QueueDeps, opts: QueueOptions): Promise<QueueRow[]> {
    if (opts.projects !== undefined) {
        for (const project of opts.projects) {
            assertKnownProject(deps.registry, project);
        }
    }
    const projects = opts.projects ?? Object.keys(deps.registry.projects);
    const state = opts.state ?? "Todo";

    const rows: QueueRow[] = [];
    for (const project of projects) {
        const issues = await deps.tracker.listQueue({ project, state });
        for (const issue of issues) {
            rows.push({
                key: issue.key,
                project,
                state: issue.state.name,
                title: issue.title,
                ...(issue.priority !== undefined ? { priority: issue.priority } : {}),
            });
        }
    }
    return rows;
}
