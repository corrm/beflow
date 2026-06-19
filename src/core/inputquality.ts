import type { Config, Registry } from "../config/schema.ts";

export const THIN_ISSUE_MESSAGE =
    "This work item was moved to Needs Input because its description looks too thin for an agent to act on safely. Please add a clear description — what needs to change, and how you'll know it's done — then leave a comment, and beflow will pick it up automatically.";

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&gt;": ">",
    "&lt;": "<",
    "&nbsp;": " ",
};

/**
 * Plane bodies are `description_html`, so a raw `.length` over-counts markup. Strip
 * tags, decode the few common entities, collapse whitespace runs, and trim, so the
 * returned length reflects the actual human-visible text.
 */
export function visibleBodyLength(body: string): number {
    const stripped = body.replace(/<[^>]*>/g, "");
    const decoded = stripped.replace(/&nbsp;|&amp;|&lt;|&gt;/g, (m) => ENTITIES[m] ?? m);
    return decoded.replace(/\s+/g, " ").trim().length;
}

export function isThinIssue(body: string, minBodyChars: number): boolean {
    return minBodyChars > 0 && visibleBodyLength(body) < minBodyChars;
}

export function resolveMinBodyChars(config: Config, registry: Registry, projectKey: string): number {
    return registry.projects[projectKey]?.inputQuality?.minBodyChars ?? config.defaults.inputQuality?.minBodyChars ?? 0;
}
