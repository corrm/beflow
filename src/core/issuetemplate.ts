import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { xdgConfigHome } from "../config/xdg.ts";
import bugDefault from "../prompts/defaults/issues/bug.md" with { type: "text" };
import featureDefault from "../prompts/defaults/issues/feature.md" with { type: "text" };
import genericDefault from "../prompts/defaults/issues/generic.md" with { type: "text" };
import spikeDefault from "../prompts/defaults/issues/spike.md" with { type: "text" };
import { renderTemplate } from "./prompts.ts";

const COMPILED_DEFAULTS: Record<string, string> = {
    bug: bugDefault,
    feature: featureDefault,
    generic: genericDefault,
    spike: spikeDefault,
};

const questionSchema = z
    .object({
        key: z.string(),
        label: z.string(),
        options: z.array(z.string()).optional(),
        required: z.boolean().default(false),
        type: z.enum(["text", "longtext", "bool", "number", "options", "multiselect"]),
    })
    .superRefine((q, ctx) => {
        if ((q.type === "options" || q.type === "multiselect") && (q.options === undefined || q.options.length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `question "${q.key}" of type "${q.type}" requires a non-empty "options" array`,
                path: ["options"],
            });
        }
    });

export type Question = z.infer<typeof questionSchema>;

export const issueTemplateSchema = z
    .object({
        agent: z.string().optional(),
        description: z.string(),
        enrich: z.boolean().default(false),
        jobKind: z.enum(["triage", "spec", "implement"]).optional(),
        labels: z.array(z.string()).optional(),
        name: z.string(),
        priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
        questions: z.array(questionSchema).default([]),
        runMode: z.enum(["autonomous", "supervised"]).optional(),
        state: z.string().optional(),
        title: z.string().optional(),
        type: z.string().optional(),
    })
    .superRefine((tpl, ctx) => {
        const seen = new Set<string>();
        for (const q of tpl.questions) {
            if (seen.has(q.key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `duplicate question key "${q.key}"`,
                    path: ["questions"],
                });
            }
            seen.add(q.key);
        }
    });

type IssueTemplateFrontmatter = z.infer<typeof issueTemplateSchema>;

export type IssueTemplate = IssueTemplateFrontmatter & { body: string };

// Injectable IO so the cascade is testable without touching the real filesystem.
export interface IssueTemplateResolveDeps {
    configDir: string;
    promptsDir?: string;
    home: string;
    exists: (p: string) => boolean;
    listDir: (dir: string) => string[];
    read: (p: string) => string;
}

export function defaultIssueTemplateResolveDeps(configDir: string, promptsDir?: string): IssueTemplateResolveDeps {
    return {
        configDir,
        exists: existsSync,
        home: homedir(),
        listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
        read: (p) => readFileSync(p, "utf8"),
        ...(promptsDir !== undefined ? { promptsDir } : {}),
    };
}

function expandHome(p: string, home: string): string {
    return p.startsWith("~") ? join(home, p.slice(1)) : p;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): { frontmatter: unknown; body: string } {
    const match = FRONTMATTER.exec(raw);
    if (match === null) {
        throw new Error("beflow: issue template has no YAML frontmatter block (must start with '---')");
    }
    return { body: match[2] ?? "", frontmatter: parseYaml(match[1] ?? "") };
}

function parseTemplate(name: string, raw: string): IssueTemplate {
    const { body, frontmatter } = parseFrontmatter(raw);
    const result = issueTemplateSchema.safeParse(frontmatter);
    if (!result.success) {
        const issue = result.error.issues[0];
        const detail = issue !== undefined ? `${issue.path.join(".")}: ${issue.message}` : result.error.message;
        throw new Error(`beflow: invalid issue template "${name}" (${detail})`);
    }
    return { ...result.data, body };
}

// Candidate dirs, highest priority first: project-local (beside config.json),
// the configured prompts.dir/issues, then $XDG_CONFIG_HOME/beflow/prompts/issues.
function candidateDirs(deps: IssueTemplateResolveDeps): string[] {
    const dirs: string[] = [join(deps.configDir, "prompts", "issues")];
    if (deps.promptsDir !== undefined) {
        dirs.push(join(expandHome(deps.promptsDir, deps.home), "issues"));
    }
    dirs.push(join(xdgConfigHome(), "prompts", "issues"));
    return dirs;
}

export function loadIssueTemplate(name: string, deps: IssueTemplateResolveDeps): IssueTemplate {
    for (const dir of candidateDirs(deps)) {
        const path = join(dir, `${name}.md`);
        if (deps.exists(path)) {
            return parseTemplate(name, deps.read(path));
        }
    }
    const compiled = COMPILED_DEFAULTS[name];
    if (compiled !== undefined) {
        return parseTemplate(name, compiled);
    }
    const available = listIssueTemplates(deps)
        .map((t) => t.name)
        .join(", ");
    throw new Error(`beflow: unknown issue template "${name}" (available: ${available})`);
}

export function listIssueTemplates(deps: IssueTemplateResolveDeps): { name: string; description: string }[] {
    // Union of names across cascade dirs (highest priority first) + compiled
    // defaults; first occurrence of a name wins for its description.
    const names: string[] = [];
    for (const dir of candidateDirs(deps)) {
        for (const file of deps.listDir(dir)) {
            if (file.endsWith(".md")) {
                names.push(file.slice(0, -".md".length));
            }
        }
    }
    names.push(...Object.keys(COMPILED_DEFAULTS));

    const seen = new Set<string>();
    const entries: { name: string; description: string }[] = [];
    for (const name of names) {
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        entries.push({ description: loadIssueTemplate(name, deps).description, name });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function renderIssueBody(template: IssueTemplate, answers: Record<string, string>): string {
    return renderTemplate(`issue:${template.name}`, template.body, answers);
}
