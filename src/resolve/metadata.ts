import { jobKindSchema, runModeSchema } from "../config/schema.ts";
import type { IssueMeta, JobKind, RunMode } from "../model/types.ts";

const BODY_BLOCK = /<!--\s*beflow\s*([\s\S]*?)-->/i;

function asRunMode(value: string): RunMode | undefined {
    const r = runModeSchema.safeParse(value);
    return r.success ? r.data : undefined;
}

function asJobKind(value: string): JobKind | undefined {
    const r = jobKindSchema.safeParse(value);
    return r.success ? r.data : undefined;
}

function parseBodyBlock(body: string): IssueMeta {
    const match = BODY_BLOCK.exec(body);
    if (!match || match[1] === undefined) {
        return {};
    }

    const meta: IssueMeta = {};
    for (const line of match[1].split("\n")) {
        const sep = line.indexOf(":");
        if (sep === -1) {
            continue;
        }
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (value === "") {
            continue;
        }

        switch (key) {
            case "agent":
                meta.agent = value;
                break;
            case "repo":
                meta.repo = value;
                break;
            case "runMode": {
                const rm = asRunMode(value);
                if (rm) {
                    meta.runMode = rm;
                }
                break;
            }
            case "jobKind": {
                const jk = asJobKind(value);
                if (jk) {
                    meta.jobKind = jk;
                }
                break;
            }
        }
    }
    return meta;
}

function parseLabels(labels: string[]): IssueMeta {
    const meta: IssueMeta = {};
    for (const label of labels) {
        const sep = label.indexOf(":");
        if (sep === -1) {
            continue;
        }
        const key = label.slice(0, sep).trim();
        const value = label.slice(sep + 1).trim();
        if (value === "") {
            continue;
        }

        switch (key) {
            case "agent":
                meta.agent = value;
                break;
            case "repo":
                meta.repo = value;
                break;
            case "run": {
                const rm = asRunMode(value);
                if (rm) {
                    meta.runMode = rm;
                }
                break;
            }
            case "jobkind": {
                const jk = asJobKind(value);
                if (jk) {
                    meta.jobKind = jk;
                }
                break;
            }
        }
    }
    return meta;
}

export function parseIssueMeta(body: string, labels: string[]): IssueMeta {
    const fromLabels = parseLabels(labels);
    const fromBody = parseBodyBlock(body);
    return { ...fromLabels, ...fromBody };
}
