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

export interface QueueError {
    project: string;
    message: string;
}

export async function queueView(
    deps: QueueDeps,
    opts: QueueOptions,
): Promise<{ rows: QueueRow[]; errors: QueueError[] }> {
    if (opts.projects !== undefined) {
        for (const project of opts.projects) {
            assertKnownProject(deps.registry, project);
        }
    }
    const projects = opts.projects ?? Object.keys(deps.registry.projects);
    const state = opts.state ?? "Todo";

    const rows: QueueRow[] = [];
    const errors: QueueError[] = [];
    for (const project of projects) {
        try {
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
        } catch (err) {
            errors.push({ message: err instanceof Error ? err.message : String(err), project });
        }
    }
    return { errors, rows };
}
