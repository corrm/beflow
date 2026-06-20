import type { Config, Registry } from "../config/schema.ts";
import type { RunRecord } from "./runstore.ts";

export interface SlaThresholds {
    inReviewMinutes?: number;
    needsInputMinutes?: number;
}

export function resolveSla(config: Config, registry: Registry, projectKey: string): SlaThresholds {
    const projectSla = registry.projects[projectKey]?.sla;
    const globalSla = config.sla;
    const inReviewMinutes = projectSla?.inReviewMinutes ?? globalSla?.inReviewMinutes;
    const needsInputMinutes = projectSla?.needsInputMinutes ?? globalSla?.needsInputMinutes;
    return {
        ...(inReviewMinutes !== undefined ? { inReviewMinutes } : {}),
        ...(needsInputMinutes !== undefined ? { needsInputMinutes } : {}),
    };
}

export function ageMinutes(nowIso: string, sinceIso: string): number {
    return (Date.parse(nowIso) - Date.parse(sinceIso)) / 60000;
}

export function formatAge(minutes: number): string {
    if (minutes < 60) {
        return `${String(Math.round(minutes))}m`;
    }
    if (minutes < 1440) {
        return `${String(Math.round(minutes / 60))}h`;
    }
    return `${String(Math.round(minutes / 1440))}d`;
}

export function shouldRemind(nowIso: string, record: RunRecord, thresholdMinutes: number): boolean {
    if (ageMinutes(nowIso, record.updatedAt) < thresholdMinutes) {
        return false;
    }
    return record.escalatedAt === undefined || ageMinutes(nowIso, record.escalatedAt) >= thresholdMinutes;
}
