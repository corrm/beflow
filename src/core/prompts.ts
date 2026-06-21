import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { xdgConfigHome } from "../config/xdg.ts";
import type { Issue, JobKind } from "../model/types.ts";
import continuationDefault from "../prompts/defaults/continuation.md" with { type: "text" };
import decisionReceiptDefault from "../prompts/defaults/decision-receipt.md" with { type: "text" };
import implementDefault from "../prompts/defaults/implement.md" with { type: "text" };
import issueEnrichDefault from "../prompts/defaults/issue-enrich.md" with { type: "text" };
import reportDefault from "../prompts/defaults/report.md" with { type: "text" };
import reviewDefault from "../prompts/defaults/review.md" with { type: "text" };
import specDefault from "../prompts/defaults/spec.md" with { type: "text" };
import taskDefault from "../prompts/defaults/task.md" with { type: "text" };
import triageDefault from "../prompts/defaults/triage.md" with { type: "text" };
import type { IssueContext } from "../trackers/tracker.ts";

export const PROMPT_NAMES = ["triage", "spec", "implement", "report", "task", "continuation", "review"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export interface PromptSet {
    triage: string;
    spec: string;
    implement: string;
    report: string;
    task: string;
    continuation: string;
    review: string;
}

const COMPILED_DEFAULTS: PromptSet = {
    continuation: continuationDefault,
    implement: implementDefault,
    report: reportDefault,
    review: reviewDefault,
    spec: specDefault,
    task: taskDefault,
    triage: triageDefault,
};

// Injectable IO so the cascade is testable without touching the real filesystem.
export interface PromptResolveDeps {
    configDir: string;
    promptsDir?: string;
    home: string;
    exists: (p: string) => boolean;
    read: (p: string) => string;
}

export function defaultPromptResolveDeps(configDir: string, promptsDir?: string): PromptResolveDeps {
    return {
        configDir,
        exists: existsSync,
        home: homedir(),
        read: (p) => readFileSync(p, "utf8"),
        ...(promptsDir !== undefined ? { promptsDir } : {}),
    };
}

function expandHome(p: string, home: string): string {
    return p.startsWith("~") ? join(home, p.slice(1)) : p;
}

// Override cascade candidate paths for a `<basename>.md`, highest priority first:
// project-local (beside config.json), the configured prompts.dir, then the global
// $XDG_CONFIG_HOME/beflow/prompts.
function promptCandidates(basename: string, deps: PromptResolveDeps): string[] {
    const candidates: string[] = [join(deps.configDir, "prompts", `${basename}.md`)];
    if (deps.promptsDir !== undefined) {
        candidates.push(join(expandHome(deps.promptsDir, deps.home), `${basename}.md`));
    }
    candidates.push(join(xdgConfigHome(), "prompts", `${basename}.md`));
    return candidates;
}

// Override cascade, highest priority first: first readable file from
// promptCandidates wins; otherwise the compiled-in default.
function resolvePrompt(name: PromptName, deps: PromptResolveDeps): string {
    for (const path of promptCandidates(name, deps)) {
        if (deps.exists(path)) {
            return deps.read(path);
        }
    }
    return COMPILED_DEFAULTS[name];
}

// The issue-authoring enrich prompt. It rides the SAME override cascade as the
// threaded PromptSet but is loaded on demand (only `beflow new --enrich` needs
// it), so it stays out of PromptSet/PROMPT_NAMES.
export function loadEnrichPrompt(deps: PromptResolveDeps): string {
    for (const path of promptCandidates("issue-enrich", deps)) {
        if (deps.exists(path)) {
            return deps.read(path);
        }
    }
    return issueEnrichDefault;
}

// The decision-receipt comment template. Like loadEnrichPrompt it rides the same
// override cascade but is on-demand (only the tracker receipt sink needs it), so
// it stays out of PromptSet/PROMPT_NAMES.
export function loadDecisionReceiptPrompt(deps: PromptResolveDeps): string {
    for (const path of promptCandidates("decision-receipt", deps)) {
        if (deps.exists(path)) {
            return deps.read(path);
        }
    }
    return decisionReceiptDefault;
}

export function loadPromptSet(deps: PromptResolveDeps): PromptSet {
    return {
        continuation: resolvePrompt("continuation", deps),
        implement: resolvePrompt("implement", deps),
        report: resolvePrompt("report", deps),
        review: resolvePrompt("review", deps),
        spec: resolvePrompt("spec", deps),
        task: resolvePrompt("task", deps),
        triage: resolvePrompt("triage", deps),
    };
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

export function renderTemplate(name: string, tpl: string, ctx: Record<string, string>): string {
    return tpl.replace(PLACEHOLDER, (_match, key: string) => {
        if (!Object.prototype.hasOwnProperty.call(ctx, key)) {
            throw new Error(`beflow: unknown placeholder "{{${key}}}" in ${name} prompt`);
        }
        return ctx[key] ?? "";
    });
}

export function buildPromptContext(issue: Issue, repo: string): Record<string, string> {
    const type = issue.type ?? "Unspecified";
    const description = issue.body.trim() === "" ? "(no description provided)" : issue.body;
    return {
        description,
        key: issue.key,
        repo,
        title: issue.title,
        type,
    };
}

export function renderTask(set: PromptSet, issue: Issue, repo: string): string {
    return renderTemplate("task", set.task, buildPromptContext(issue, repo));
}

const AGENT_OWNED_PR_INSTRUCTION = "commit, push, and open a pull request with `gh`, then put the PR URL in `prUrl`.";
const BEFLOW_OWNED_PR_INSTRUCTION =
    "commit and push your branch. Do NOT run `gh pr create`, `gh pr edit`, or open or update any pull request — beflow will open the PR from your pushed branch.";

const AGENT_OWNED_PR_CONTINUATION_INSTRUCTION = "UPDATE the existing pull request — do not open a new one.";
const BEFLOW_OWNED_PR_CONTINUATION_INSTRUCTION =
    "push your changes. The existing pull request updates automatically — do NOT run `gh pr create` or `gh pr edit`.";

export function renderContract(
    set: PromptSet,
    jobKind: JobKind,
    issue: Issue,
    repo: string,
    beflowOwnsPr = false,
): string {
    const ctx = buildPromptContext(issue, repo);
    const promptCtx =
        jobKind === "implement"
            ? {
                  ...ctx,
                  pr_continuation_instruction: beflowOwnsPr
                      ? BEFLOW_OWNED_PR_CONTINUATION_INSTRUCTION
                      : AGENT_OWNED_PR_CONTINUATION_INSTRUCTION,
                  pr_instruction: beflowOwnsPr ? BEFLOW_OWNED_PR_INSTRUCTION : AGENT_OWNED_PR_INSTRUCTION,
              }
            : ctx;
    return `${renderTemplate(jobKind, set[jobKind], promptCtx)}\n\n${renderTemplate("report", set.report, ctx)}`;
}

export function renderReviewContract(set: PromptSet, issue: Issue, repo: string): string {
    return renderTemplate("review", set.review, buildPromptContext(issue, repo));
}

// Render the linked context (parent epic + attachments) appended to the agent
// Task. Pure and deterministic; returns "" when there is nothing to inline.
export function renderLinkedContext(ctx: IssueContext): string {
    const { attachments, parent } = ctx;
    if (parent === undefined && attachments.length === 0) {
        return "";
    }

    let out = "\n\n## Linked context\n";
    if (parent !== undefined) {
        const label = parent.type ?? "item";
        out += `\nParent ${label} ${parent.key} "${parent.title}":\n${parent.body || "(no description)"}\n`;
    }
    if (attachments.length > 0) {
        out += "\nAttachments (download URLs are temporary):\n";
        for (const a of attachments) {
            out += a.url !== "" ? `- ${a.name} (${a.url})\n` : `- ${a.name} (no direct download link)\n`;
        }
    }
    return out;
}
