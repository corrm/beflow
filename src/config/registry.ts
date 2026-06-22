import type { Project, Registry } from "./schema.ts";

// Throws a clear, actionable error when a project key is not registered, so the
// unvalidated key never reaches the tracker and surfaces as a raw 404/400. Call
// this at a command boundary before any tracker call that takes a project key.
// Returns the resolved project entry so callers avoid a redundant lookup.
export function assertKnownProject(registry: Registry, key: string): Project {
    const project = registry.projects[key];
    if (project !== undefined) {
        return project;
    }
    const known = Object.keys(registry.projects);
    const list = known.length > 0 ? known.join(", ") : "none";
    throw new Error(`beflow: unknown project "${key}" (known: ${list}) — run \`beflow setup ${key}\` to register it`);
}
