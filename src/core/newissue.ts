import { cancel, confirm, isCancel, multiselect, note, select, text } from "@clack/prompts";

import type { AgentDriver } from "../agent/driver.ts";
import { extractIssueFence, type IssueFence } from "../agent/issuefence.ts";
import type { Issue } from "../model/types.ts";
import type { IssueDraft, Tracker } from "../trackers/tracker.ts";
import {
    listIssueTemplates,
    loadIssueTemplate,
    renderIssueBody,
    type IssueTemplate,
    type IssueTemplateResolveDeps,
    type Question,
} from "./issuetemplate.ts";
import { renderTemplate } from "./prompts.ts";
import type { Logger } from "./run.ts";

// Injected IO boundaries; the clack-backed defaults below are the TTY edge, so the
// orchestration core stays fully unit-testable without a TTY.
export type AskTemplate = (templates: { name: string; description: string }[]) => Promise<string>;
export type AskQuestions = (questions: Question[]) => Promise<Record<string, string>>;
export type AskConfirm = (preview: string) => Promise<boolean>;

// The agent-enrich boundary: given the form answers + the seed draft, an agent
// investigates the repo READ-ONLY and returns a complete issue (or null to fall
// back to the form draft). Injected so the core stays unit-testable.
export interface EnrichInput {
    template: IssueTemplate;
    answers: Record<string, string>;
    seedTitle: string;
    seedBody: string;
}
export type EnrichIssue = (input: EnrichInput) => Promise<IssueFence | null>;

function formatAnswers(answers: Record<string, string>): string {
    return Object.entries(answers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
}

// Builds the default agent-backed enrich function: it runs the authoring agent
// one-shot and READ-ONLY (acpx `exec` + `--approve-reads` +
// `--non-interactive-permissions deny`) in the project's repo, then extracts the
// `beflow-issue` block. Any driver error degrades to null so enrich never crashes
// issue creation.
export function defaultEnrichIssue(opts: {
    driver: AgentDriver;
    resolveAcp: (agent: string) => string;
    enrichPrompt: string;
    repoPath: string;
    defaultAgent: string;
    log?: Logger;
}): EnrichIssue {
    return async (input: EnrichInput): Promise<IssueFence | null> => {
        const agent = input.template.agent ?? opts.defaultAgent;
        const acpCommand = opts.resolveAcp(agent);
        const task = renderTemplate("issue-enrich", opts.enrichPrompt, {
            answers: formatAnswers(input.answers),
            draft: input.seedBody,
            format: input.template.body,
            title: input.seedTitle,
        });
        try {
            const result = await opts.driver.run({
                acpCommand,
                cwd: opts.repoPath,
                nonInteractive: "deny",
                oneShot: true,
                runMode: "supervised",
                sessionKey: "beflow-new",
                task,
            });
            return extractIssueFence(result.stream.assistantText);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            opts.log?.(`beflow: enrich agent failed (${msg}); using the form draft`);
            return null;
        }
    };
}

// Shared cancel path for every clack prompt: a Ctrl-C aborts cleanly so nothing is
// created. Like defaultAskOutcome in run.ts, these defaults are NOT unit-tested.
function cancelled(): never {
    cancel("Cancelled.");
    throw new Error("beflow: issue creation cancelled");
}

export async function defaultAskTemplate(templates: { name: string; description: string }[]): Promise<string> {
    const choice = await select({
        message: "Pick an issue template",
        options: templates.map((t) => ({ hint: t.description, label: t.name, value: t.name })),
    });
    if (isCancel(choice)) {
        cancelled();
    }
    return choice;
}

export async function defaultAskQuestions(questions: Question[]): Promise<Record<string, string>> {
    const answers: Record<string, string> = {};
    for (const question of questions) {
        const { required } = question;
        switch (question.type) {
            case "text": {
                const value = await text({
                    message: question.label,
                    ...(required
                        ? {
                              validate: (v: string | undefined): string | undefined =>
                                  (v ?? "").trim() === "" ? "Required" : undefined,
                          }
                        : {}),
                });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value;
                break;
            }
            case "longtext": {
                // clack has no native multiline input, so longtext is a single-line
                // text prompt; Enter submits. Multi-paragraph bodies aren't supported
                // here — author them in a template file instead.
                const value = await text({
                    message: question.label,
                    placeholder: "single line — Enter submits",
                    ...(required
                        ? {
                              validate: (v: string | undefined): string | undefined =>
                                  (v ?? "").trim() === "" ? "Required" : undefined,
                          }
                        : {}),
                });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value;
                break;
            }
            case "bool": {
                const value = await confirm({ message: question.label });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value ? "Yes" : "No";
                break;
            }
            case "number": {
                const value = await text({
                    message: question.label,
                    validate: (v: string | undefined): string | undefined => {
                        const trimmed = (v ?? "").trim();
                        if (trimmed !== "" && Number.isNaN(Number(trimmed))) {
                            return "Must be a number";
                        }
                        return required && trimmed === "" ? "Required" : undefined;
                    },
                });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value.trim();
                break;
            }
            case "options": {
                // The schema guarantees options is non-empty for this type.
                const value = await select({
                    message: question.label,
                    options: (question.options ?? []).map((o) => ({ label: o, value: o })),
                });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value;
                break;
            }
            case "multiselect": {
                const value = await multiselect({
                    message: question.label,
                    options: (question.options ?? []).map((o) => ({ label: o, value: o })),
                    required,
                });
                if (isCancel(value)) {
                    cancelled();
                }
                answers[question.key] = value.join(", ");
                break;
            }
        }
    }
    return answers;
}

export async function defaultAskConfirm(preview: string): Promise<boolean> {
    note(preview, "New issue");
    const ok = await confirm({ message: "Create this work item?" });
    if (isCancel(ok)) {
        cancelled();
    }
    return ok;
}

export interface NewIssueDeps {
    tracker: Tracker;
    templateDeps: IssueTemplateResolveDeps;
    askTemplate: AskTemplate;
    askQuestions: AskQuestions;
    askConfirm: AskConfirm;
    enrich?: EnrichIssue;
    log?: Logger;
    defaultState?: string;
}

const DEFAULT_STATE = "Backlog";

function fillAnswers(questions: Question[], raw: Record<string, string>): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const q of questions) {
        answers[q.key] = raw[q.key] ?? "";
    }
    return answers;
}

function deriveTitle(template: IssueTemplate, answers: Record<string, string>): string {
    const raw =
        template.title !== undefined
            ? renderTemplate(`issue:${template.name}:title`, template.title, answers)
            : (answers.title ?? answers.summary ?? answers[template.questions[0]?.key ?? ""] ?? "");
    const title = raw.trim();
    if (title === "") {
        throw new Error(
            `beflow: issue template "${template.name}" produced an empty title — add a "title" pattern or a "title"/"summary" question`,
        );
    }
    return title;
}

const RESERVED_LABEL_PREFIXES = ["agent", "run", "jobkind"] as const;

function labelPrefix(label: string): string | null {
    const sep = label.indexOf(":");
    if (sep === -1) {
        return null;
    }
    const key = label.slice(0, sep);
    return (RESERVED_LABEL_PREFIXES as readonly string[]).includes(key) ? key : null;
}

function mapLabels(template: IssueTemplate, extra: string[] = []): string[] {
    const labels = [...(template.labels ?? [])];
    if (template.agent !== undefined) {
        labels.push(`agent:${template.agent}`);
    }
    if (template.runMode !== undefined) {
        labels.push(`run:${template.runMode}`);
    }
    if (template.jobKind !== undefined) {
        labels.push(`jobkind:${template.jobKind}`);
    }

    const occupiedNamespaces = new Set<string>();
    for (const label of labels) {
        const prefix = labelPrefix(label);
        if (prefix !== null) {
            occupiedNamespaces.add(prefix);
        }
    }

    for (const label of extra) {
        const prefix = labelPrefix(label);
        if (prefix !== null && occupiedNamespaces.has(prefix)) {
            continue;
        }
        labels.push(label);
    }

    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const label of labels) {
        if (!seen.has(label)) {
            seen.add(label);
            deduped.push(label);
        }
    }
    return deduped;
}

function buildPreview(draft: IssueDraft): string {
    return [
        `Title:  ${draft.title}`,
        `State:  ${draft.state ?? DEFAULT_STATE}`,
        `Type:   ${draft.type ?? "—"}`,
        `Labels: ${draft.labels !== undefined && draft.labels.length > 0 ? draft.labels.join(", ") : "—"}`,
        "─────────────────────────────",
        draft.body,
    ].join("\n");
}

export async function newIssue(
    project: string,
    templateName: string | undefined,
    deps: NewIssueDeps,
): Promise<Issue | null> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });

    let template: IssueTemplate;
    if (templateName !== undefined) {
        template = loadIssueTemplate(templateName, deps.templateDeps);
    } else {
        const list = listIssueTemplates(deps.templateDeps);
        if (list.length === 0) {
            throw new Error("beflow: no issue templates available to choose from");
        }
        const chosen = await deps.askTemplate(list);
        template = loadIssueTemplate(chosen, deps.templateDeps);
    }

    const raw = await deps.askQuestions(template.questions);
    const answers = fillAnswers(template.questions, raw);

    let title = deriveTitle(template, answers);
    let body = renderIssueBody(template, answers);

    // Template values stay authoritative; enrich only fills what the template
    // leaves unset. Enrich is skipped for enrich:false templates and on the form
    // path (deps.enrich undefined).
    let type: string | undefined = template.type;
    let priority: string | undefined = template.priority;
    let extraLabels: string[] = [];
    if (template.enrich && deps.enrich !== undefined) {
        const fence = await deps.enrich({ answers, seedBody: body, seedTitle: title, template });
        if (fence !== null) {
            body = fence.body;
            if (fence.title !== undefined && fence.title.trim() !== "") {
                title = fence.title.trim();
            }
            type = template.type ?? fence.type;
            priority = template.priority ?? fence.priority;
            extraLabels = fence.labels ?? [];
        } else {
            log("beflow: enrich produced no issue block; using the form draft");
        }
    }

    const labels = mapLabels(template, extraLabels);

    const draft: IssueDraft = {
        body,
        state: template.state ?? deps.defaultState ?? DEFAULT_STATE,
        title,
        ...(type !== undefined ? { type } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(labels.length > 0 ? { labels } : {}),
    };

    const ok = await deps.askConfirm(buildPreview(draft));
    if (!ok) {
        log("beflow: issue creation cancelled");
        return null;
    }

    const issue = await deps.tracker.createIssue(project, draft);
    log(`beflow: created ${issue.key}`);
    return issue;
}
