export const PREFLIGHT_BLOCK_MESSAGE =
    "This work item was moved to Needs Input because the file paths it declares fall under a control-plane block in the project's policy — an agent could not land this change as scoped. Please review and narrow the scope (or split out the blocked paths), then leave a comment, and beflow will pick it up automatically.";

const ENTITIES: Record<string, string> = {
    "&amp;": "&",
    "&gt;": ">",
    "&lt;": "<",
    "&nbsp;": " ",
};

function decodeBody(text: string): string {
    const stripped = text.replace(/<[^>]*>/g, " ");
    return stripped.replace(/&nbsp;|&amp;|&lt;|&gt;/g, (m) => ENTITIES[m] ?? m);
}

// A token is a confident repo-path candidate when it contains a path separator
// AND a file extension (foo/bar.ts), OR is a dotfile-rooted path (.github/...).
// Both shapes are deliberately strict: a bare word, a prose sentence, or a code
// identifier without a separator never qualifies, so a false "block" is rare.
const PATH_TOKEN = /^[\w./-]+\/[\w./-]+\.[A-Za-z]\w*$/;
const DOTFILE_PATH_TOKEN = /^\.[\w.-]+\/[\w./-]+$/;

function isUrlLike(token: string): boolean {
    return /^[a-z][\w+.-]*:\/\//i.test(token);
}

function looksLikeHostname(token: string): boolean {
    const firstSegment = token.split("/")[0] ?? "";
    return /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/i.test(firstSegment);
}

function looksLikePath(token: string): boolean {
    if (token.length === 0 || isUrlLike(token) || looksLikeHostname(token)) {
        return false;
    }
    return PATH_TOKEN.test(token) || DOTFILE_PATH_TOKEN.test(token);
}

/**
 * Extract confident repo-path candidates from an issue's title and body. The only
 * accepted signals are path-like tokens (a separator plus an extension, or a
 * dotfile-rooted path); prose, URLs, and bare identifiers are ignored. The result
 * is de-duped and order-preserving, and is empty when the issue declares no paths
 * — the preflight must never short-circuit on no signal.
 */
export function derivePreflightPaths(title: string, body: string): string[] {
    const text = `${decodeBody(title)} ${decodeBody(body)}`;
    const seen = new Set<string>();
    for (const raw of text.split(/[\s,;()[\]{}<>"'`]+/)) {
        const token = raw.replace(/[.,;:]+$/, "");
        if (looksLikePath(token)) {
            seen.add(token);
        }
    }
    return [...seen];
}
