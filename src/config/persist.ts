import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { fileSchema } from "./schema.ts";
import type { Project } from "./schema.ts";

export interface PersistDeps {
    read?: (path: string) => string;
    write?: (path: string, data: string) => void;
}

const projectsExtractSchema = z.object({ projects: z.record(z.string(), z.unknown()).optional() });

function writeProjectEntry(
    dir: string,
    key: string,
    project: Project,
    failIfExists: boolean,
    deps?: PersistDeps,
): void {
    const path = join(dir, "config.json");

    function read(p: string): string {
        return deps?.read ? deps.read(p) : readFileSync(p, "utf8");
    }

    function write(p: string, data: string): void {
        if (deps?.write) {
            deps.write(p, data);
        } else {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, data, "utf8");
        }
    }

    const raw = read(path);

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`beflow: ${path} is not valid JSON: ${reason}`, { cause: err });
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`beflow: ${path} must be a JSON object`);
    }

    const { projects: existingProjects } = projectsExtractSchema.parse(parsed);

    if (failIfExists && existingProjects?.[key] !== undefined) {
        throw new Error(`beflow: project "${key}" already exists in ${path}`);
    }

    const projects: Record<string, unknown> = { ...existingProjects, [key]: project };
    const merged = Object.assign({}, parsed, { projects });

    fileSchema.parse(merged);

    write(path, `${JSON.stringify(merged, null, 2)}\n`);
}

// Register a brand-new project. Throws if the key already exists so `setup` never
// silently clobbers an existing registry entry.
export function addProject(dir: string, key: string, project: Project, deps?: PersistDeps): void {
    writeProjectEntry(dir, key, project, true, deps);
}

// Write a project entry whether or not it already exists. Used by `update` to
// persist a freshly resolved tracker link back into the config.
export function upsertProject(dir: string, key: string, project: Project, deps?: PersistDeps): void {
    writeProjectEntry(dir, key, project, false, deps);
}
