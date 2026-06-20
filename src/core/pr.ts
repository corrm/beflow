import type { Exec } from "./worktree.ts";

export interface PrRef {
    number: number;
    url: string;
}

const AUTO_BASE = "auto";

// stderr substrings gh emits when the requested transition is already done.
// These are benign (idempotent no-ops), not real failures.
const ALREADY_READY = /already.*(ready|open for review)|not.*draft/i;
const ALREADY_CLOSED = /already closed|could not resolve to a pullrequest|no pull requests found/i;

async function runGh(args: string[], exec: Exec): Promise<string> {
    const result = await exec("gh", args);
    if (result.code !== 0) {
        throw new Error(`beflow: gh ${args.join(" ")} failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
    }
    return result.stdout;
}

async function runGitIn(cwd: string, args: string[], exec: Exec): Promise<string> {
    const fullArgs = ["-C", cwd, ...args];
    const result = await exec("git", fullArgs);
    if (result.code !== 0) {
        throw new Error(
            `beflow: git ${fullArgs.join(" ")} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
        );
    }
    return result.stdout;
}

function prSelector(pr: PrRef | number | string): string {
    if (typeof pr === "object") {
        return String(pr.number);
    }
    return typeof pr === "number" ? String(pr) : pr;
}

/**
 * Resolve the base branch. An explicit value is returned verbatim; the sentinel
 * `"auto"` triggers detection of the repo's default branch via gh.
 */
export async function detectBaseBranch(repo: string, baseBranch: string, exec: Exec): Promise<string> {
    if (baseBranch !== AUTO_BASE) {
        return baseBranch;
    }
    const stdout = await runGh(
        ["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
        exec,
    );
    return stdout.trim();
}

/**
 * True iff the worktree's HEAD carries commits that `base` lacks — the
 * "did the agent actually produce work" check that keeps PR-open a no-op
 * when nothing changed.
 */
export async function hasCommits(cwd: string, base: string, exec: Exec): Promise<boolean> {
    const stdout = await runGitIn(cwd, ["rev-list", "--count", `${base}..HEAD`], exec);
    return Number.parseInt(stdout.trim(), 10) > 0;
}

function parsePrRef(stdout: string): PrRef {
    const trimmed = stdout.trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // `gh pr create` prints the bare PR URL on success.
        const number = Number.parseInt(trimmed.split("/").at(-1) ?? "", 10);
        if (Number.isNaN(number)) {
            throw new Error(`beflow: could not parse PR from gh output: ${trimmed}`);
        }
        return { number, url: trimmed };
    }
    const obj: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? { ...parsed } : {};
    const url = typeof obj.url === "string" ? obj.url : "";
    const number = typeof obj.number === "number" ? obj.number : Number.NaN;
    if (url === "" || Number.isNaN(number)) {
        throw new Error(`beflow: could not parse PR from gh output: ${trimmed}`);
    }
    return { number, url };
}

/**
 * Open a draft PR for `head` against `base`. Idempotent: if a PR for that head
 * already exists, the existing one is returned instead of failing.
 */
export async function openDraftPr(
    args: { repo: string; head: string; base: string; title: string; body: string; cwd: string },
    exec: Exec,
): Promise<PrRef> {
    const created = await exec("gh", [
        "pr",
        "create",
        "--repo",
        args.repo,
        "--draft",
        "--base",
        args.base,
        "--head",
        args.head,
        "--title",
        args.title,
        "--body",
        args.body,
    ]);
    if (created.code === 0) {
        return parsePrRef(created.stdout);
    }
    const existing = await exec("gh", ["pr", "view", args.head, "--repo", args.repo, "--json", "url,number"]);
    if (existing.code === 0) {
        return parsePrRef(existing.stdout);
    }
    throw new Error(
        `beflow: gh pr create (head ${args.head}) failed (exit ${String(created.code)}): ${created.stderr.trim()}`,
    );
}

/** Mark a PR ready for review. Tolerant of a PR that is already ready. */
export async function markReady(pr: PrRef | number | string, repo: string, exec: Exec): Promise<void> {
    const result = await exec("gh", ["pr", "ready", prSelector(pr), "--repo", repo]);
    if (result.code === 0 || ALREADY_READY.test(result.stderr)) {
        return;
    }
    throw new Error(`beflow: gh pr ready failed (exit ${String(result.code)}): ${result.stderr.trim()}`);
}

/** Edit a PR's title and/or body. Only the provided fields are passed to gh. */
export async function editPr(
    pr: PrRef | number | string,
    repo: string,
    fields: { title?: string; body?: string },
    exec: Exec,
): Promise<void> {
    if (fields.title === undefined && fields.body === undefined) {
        return;
    }
    const args = ["pr", "edit", prSelector(pr), "--repo", repo];
    if (fields.title !== undefined) {
        args.push("--title", fields.title);
    }
    if (fields.body !== undefined) {
        args.push("--body", fields.body);
    }
    await runGh(args, exec);
}

/**
 * Close a PR while KEEPING its head branch. The branch is preserved so a blocked
 * change stays available for review and forensics. Idempotent: an already-closed
 * PR is tolerated.
 */
export async function closePr(pr: PrRef | number | string, repo: string, exec: Exec): Promise<void> {
    const closed = await exec("gh", ["pr", "close", prSelector(pr), "--repo", repo]);
    if (closed.code !== 0 && !ALREADY_CLOSED.test(closed.stderr)) {
        throw new Error(`beflow: gh pr close failed (exit ${String(closed.code)}): ${closed.stderr.trim()}`);
    }
}
