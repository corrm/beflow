import type { Config, Registry } from "../config/schema.ts";

export const THIN_ISSUE_MESSAGE =
    "This work item was moved to Needs Input because its description looks too thin for an agent to act on safely. Please add a clear description — what needs to change, and how you'll know it's done — then leave a comment, and beflow will pick it up automatically.";

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&apos;": "'",
    "&gt;": ">",
    "&lt;": "<",
    "&nbsp;": " ",
    "&quot;": '"',
    "&#39;": "'",
};

/**
 * Plane bodies are `description_html`, so a raw `.length` over-counts markup. Strip
 * tags, decode the few common entities, collapse whitespace runs, and trim, so the
 * returned length reflects the actual human-visible text.
 */
export function visibleBodyLength(body: string): number {
    const stripped = body.replace(/<[^>]*>/g, "");
    const namedDecoded = stripped.replace(/&(?:amp|apos|gt|lt|nbsp|quot|#39);/g, (m) => ENTITIES[m] ?? m);
    const decoded = namedDecoded.replace(
        /&#(?:x([0-9a-fA-F]+)|(\d+));/g,
        (_m: string, hex: string | undefined, dec: string | undefined) => {
            const codepoint = hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
            if (isNaN(codepoint) || codepoint > 0x10ffff) {
                return _m;
            }
            return String.fromCodePoint(codepoint);
        },
    );
    return decoded.replace(/\s+/g, " ").trim().length;
}

export function isThinIssue(body: string, minBodyChars: number): boolean {
    return minBodyChars > 0 && visibleBodyLength(body) < minBodyChars;
}

export function resolveMinBodyChars(config: Config, registry: Registry, projectKey: string): number {
    return registry.projects[projectKey]?.inputQuality?.minBodyChars ?? config.inputQuality?.minBodyChars ?? 0;
}
