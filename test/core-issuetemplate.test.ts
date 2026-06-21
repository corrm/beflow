import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { xdgConfigHome } from "../src/config/xdg.ts";
import {
    issueTemplateSchema,
    listIssueTemplates,
    loadIssueTemplate,
    parseFrontmatter,
    renderIssueBody,
    type IssueTemplate,
    type IssueTemplateResolveDeps,
} from "../src/core/issuetemplate.ts";

const BUG_TEMPLATE = `---
name: bug
description: A reproducible defect
agent: claude
jobKind: implement
runMode: autonomous
type: Bug
priority: high
state: Backlog
labels: [regression]
enrich: true
questions:
  - { key: summary,  label: One-line summary,      type: text,    required: true }
  - { key: steps,    label: Steps to reproduce,    type: longtext }
  - { key: severity, label: Severity, type: options, options: [low, med, high] }
---
## Summary
{{summary}}
## Steps
{{steps}}
`;

// Run a body with XDG_CONFIG_HOME pinned to an absolute path so the global
// Template-dir fallback (xdgConfigHome()) is hermetic; restore the prior value.
function withXdgConfigHome(body: (globalDir: string) => void): void {
    const prior = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg-config";
    try {
        body(xdgConfigHome());
    } finally {
        if (prior === undefined) {
            delete process.env.XDG_CONFIG_HOME;
        } else {
            process.env.XDG_CONFIG_HOME = prior;
        }
    }
}

function depsFrom(files: Record<string, string>, promptsDir?: string): IssueTemplateResolveDeps {
    const dirEntries = (dir: string): string[] => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        const out: string[] = [];
        for (const path of Object.keys(files)) {
            if (path.startsWith(prefix)) {
                const rest = path.slice(prefix.length);
                if (!rest.includes("/")) {
                    out.push(rest);
                }
            }
        }
        return out;
    };
    return {
        configDir: "/cfg",
        exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
        home: "/home",
        listDir: dirEntries,
        read: (p) => {
            const v = files[p];
            if (v === undefined) {
                throw new Error(`unexpected read ${p}`);
            }
            return v;
        },
        ...(promptsDir !== undefined ? { promptsDir } : {}),
    };
}

describe("parseFrontmatter", () => {
    it("splits frontmatter and body", () => {
        const { frontmatter, body } = parseFrontmatter("---\nname: x\ndescription: y\n---\n## Body\nhello\n");
        expect(frontmatter).toEqual({ description: "y", name: "x" });
        expect(body).toBe("## Body\nhello\n");
    });

    it("throws when there is no frontmatter block", () => {
        expect(() => parseFrontmatter("## Just a body\nno frontmatter")).toThrow(/no YAML frontmatter/);
    });
});

describe("issueTemplateSchema", () => {
    function fm(raw: string): unknown {
        return parseFrontmatter(raw).frontmatter;
    }

    it("parses a valid template", () => {
        const result = issueTemplateSchema.safeParse(fm(BUG_TEMPLATE));
        expect(result.success).toBe(true);
    });

    it("rejects options type without options", () => {
        const raw = "---\nname: x\ndescription: y\nquestions:\n  - { key: a, label: A, type: options }\n---\nbody\n";
        const result = issueTemplateSchema.safeParse(fm(raw));
        expect(result.success).toBe(false);
    });

    it("rejects multiselect type without options", () => {
        const raw =
            "---\nname: x\ndescription: y\nquestions:\n  - { key: a, label: A, type: multiselect }\n---\nbody\n";
        expect(issueTemplateSchema.safeParse(fm(raw)).success).toBe(false);
    });

    it("rejects duplicate question keys", () => {
        const raw =
            "---\nname: x\ndescription: y\nquestions:\n  - { key: a, label: A, type: text }\n  - { key: a, label: B, type: text }\n---\nbody\n";
        expect(issueTemplateSchema.safeParse(fm(raw)).success).toBe(false);
    });

    it("rejects a bad jobKind enum", () => {
        const raw = "---\nname: x\ndescription: y\njobKind: nonsense\n---\nbody\n";
        expect(issueTemplateSchema.safeParse(fm(raw)).success).toBe(false);
    });

    it("rejects a bad priority enum", () => {
        const raw = "---\nname: x\ndescription: y\npriority: critical\n---\nbody\n";
        expect(issueTemplateSchema.safeParse(fm(raw)).success).toBe(false);
    });

    it("defaults enrich to false and required to false", () => {
        const raw = "---\nname: x\ndescription: y\nquestions:\n  - { key: a, label: A, type: text }\n---\nbody\n";
        const result = issueTemplateSchema.parse(fm(raw));
        expect(result.enrich).toBe(false);
        expect(result.questions[0]?.required).toBe(false);
    });
});

describe("loadIssueTemplate — cascade", () => {
    it("configDir wins over the global dir", () => {
        withXdgConfigHome((globalDir) => {
            const tpl = loadIssueTemplate(
                "bug",
                depsFrom({
                    "/cfg/prompts/issues/bug.md": BUG_TEMPLATE,
                    [join(globalDir, "prompts", "issues", "bug.md")]:
                        "---\nname: bug\ndescription: GLOBAL\n---\nbody\n",
                }),
            );
            expect(tpl.description).toBe("A reproducible defect");
        });
    });

    it("respects promptsDir over the global dir", () => {
        withXdgConfigHome((globalDir) => {
            const tpl = loadIssueTemplate(
                "bug",
                depsFrom(
                    {
                        "/custom/issues/bug.md": "---\nname: bug\ndescription: CUSTOM\n---\nbody\n",
                        [join(globalDir, "prompts", "issues", "bug.md")]:
                            "---\nname: bug\ndescription: GLOBAL\n---\nbody\n",
                    },
                    "/custom",
                ),
            );
            expect(tpl.description).toBe("CUSTOM");
        });
    });

    it("expands a leading ~ in promptsDir", () => {
        const tpl = loadIssueTemplate(
            "bug",
            depsFrom(
                { "/home/agent-prompts/issues/bug.md": "---\nname: bug\ndescription: TILDE\n---\nbody\n" },
                "~/agent-prompts",
            ),
        );
        expect(tpl.description).toBe("TILDE");
    });

    it("falls back to the compiled generic default", () => {
        const tpl = loadIssueTemplate("generic", depsFrom({}));
        expect(tpl.name).toBe("generic");
        expect(tpl.body).toContain("{{summary}}");
    });

    it("throws on an unknown name with the available list", () => {
        expect(() => loadIssueTemplate("nope", depsFrom({}))).toThrow(/unknown issue template "nope".*generic/);
    });
});

describe("listIssueTemplates", () => {
    it("unions and dedupes across dirs and compiled defaults, sorted, higher priority wins description", () => {
        withXdgConfigHome((globalDir) => {
            const entries = listIssueTemplates(
                depsFrom({
                    "/cfg/prompts/issues/bug.md": BUG_TEMPLATE,
                    [join(globalDir, "prompts", "issues", "bug.md")]:
                        "---\nname: bug\ndescription: GLOBAL-BUG\n---\nbody\n",
                    [join(globalDir, "prompts", "issues", "zeta.md")]: "---\nname: zeta\ndescription: Z\n---\nbody\n",
                }),
            );
            expect(entries.map((e) => e.name)).toEqual(["bug", "feature", "generic", "spike", "zeta"]);
            expect(entries.find((e) => e.name === "bug")?.description).toBe("A reproducible defect");
        });
    });
});

describe("renderIssueBody", () => {
    it("substitutes placeholders", () => {
        const tpl: IssueTemplate = {
            body: "## Summary\n{{summary}}\n## Steps\n{{steps}}",
            description: "d",
            enrich: false,
            name: "bug",
            questions: [],
        };
        expect(renderIssueBody(tpl, { steps: "1. do it", summary: "it broke" })).toBe(
            "## Summary\nit broke\n## Steps\n1. do it",
        );
    });

    it("throws on an unknown placeholder", () => {
        const tpl: IssueTemplate = {
            body: "{{nope}}",
            description: "d",
            enrich: false,
            name: "bug",
            questions: [],
        };
        expect(() => renderIssueBody(tpl, {})).toThrow(/unknown placeholder/);
    });
});

describe("compiled defaults", () => {
    it("parses and validates the generic default", () => {
        const tpl = loadIssueTemplate("generic", depsFrom({}));
        expect(tpl.name).toBe("generic");
        expect(tpl.enrich).toBe(false);
        expect(tpl.questions.map((q) => q.key)).toEqual(["summary", "context"]);
    });

    it.each(["bug", "feature", "generic", "spike"])("loads and validates the %s default", (name) => {
        const tpl = loadIssueTemplate(name, depsFrom({}));
        expect(tpl.name).toBe(name);
        expect(tpl.enrich).toBe(false);
        expect(tpl.questions.length).toBeGreaterThan(0);
    });

    it("lists exactly the four shipped defaults sorted with descriptions over empty dirs", () => {
        const entries = listIssueTemplates(depsFrom({}));
        expect(entries.map((e) => e.name)).toEqual(["bug", "feature", "generic", "spike"]);
        expect(entries.map((e) => e.description)).toEqual([
            "A reproducible defect — steps, expected vs actual",
            "A new capability — motivation + acceptance criteria",
            "A blank issue — summary plus free-form context",
            "A time-boxed investigation — a question to answer",
        ]);
    });
});
