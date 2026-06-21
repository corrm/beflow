import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { xdgConfigHome } from "../src/config/xdg.ts";
import { renderContinuation } from "../src/core/continuation.ts";
import type { ContinuationContext } from "../src/core/continuation.ts";
import {
    buildPromptContext,
    loadPromptSet,
    renderContract,
    renderLinkedContext,
    renderReviewContract,
    renderTask,
    renderTemplate,
    type PromptResolveDeps,
    type PromptSet,
} from "../src/core/prompts.ts";
import type { Issue, JobKind } from "../src/model/types.ts";
import type { IssueContext } from "../src/trackers/tracker.ts";

const JOB_KINDS: JobKind[] = ["triage", "spec", "implement"];

// Run a body with XDG_CONFIG_HOME pinned to an absolute path so the global
// Prompt-dir fallback (xdgConfigHome()) is hermetic; restore the prior value.
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

// Substrings that would re-couple a contract to a specific issue tracker or
// Reintroduce tracker I/O. The agent never touches the tracker — beflow does.
const TRACKER_DENY_LIST = [
    "plane",
    "linear",
    " mcp",
    "mcp__",
    "the board",
    "move it to",
    "move the issue",
    "update the state",
    "comment on the issue",
];

function issue(overrides: Partial<Issue> = {}): Issue {
    return {
        areas: [],
        body: "It crashes when exporting a PDF on Safari.",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "Crash on export",
        type: "Bug",
        ...overrides,
    };
}

// A PromptSet built purely from the compiled-in defaults (every cascade miss).
function defaultSet(): PromptSet {
    return loadPromptSet({ configDir: "/cfg", exists: () => false, home: "/home", read: () => "" });
}

const REPO = "main_repo";

describe("loadPromptSet — compiled defaults", () => {
    it("returns the compiled-in defaults when every cascade candidate misses", () => {
        const set = defaultSet();
        expect(set.triage).toContain("TRIAGE");
        expect(set.spec).toContain("SPEC");
        expect(set.implement).toContain("IMPLEMENT");
        expect(set.report).toContain("beflow-report");
        expect(set.task).toContain("Work item: {{key}}");
        expect(set.continuation).toContain("returning to you");
    });
});

describe("renderContract — report channel", () => {
    for (const jobKind of JOB_KINDS) {
        it(`${jobKind} bakes in the beflow-report instruction`, () => {
            expect(renderContract(defaultSet(), jobKind, issue(), REPO)).toContain("beflow-report");
        });
    }
});

describe("renderContract — tracker-agnosticism", () => {
    for (const jobKind of JOB_KINDS) {
        it(`${jobKind} mentions no tracker term`, () => {
            const c = renderContract(defaultSet(), jobKind, issue(), REPO).toLowerCase();
            for (const term of TRACKER_DENY_LIST) {
                expect(c).not.toContain(term);
            }
        });
    }
});

describe("renderContract — jobKind-specific intent", () => {
    it("triage requires acceptance criteria and forbids code/PR", () => {
        const c = renderContract(defaultSet(), "triage", issue(), REPO);
        expect(c).toMatch(/acceptance criteria/i);
        expect(c).toMatch(/do NOT write code/i);
        expect(c).toMatch(/do NOT open a PR/i);
        expect(c).not.toContain("nextState");
    });

    it("spec forbids implementing", () => {
        const c = renderContract(defaultSet(), "spec", issue(), REPO);
        expect(c).toMatch(/do NOT implement/i);
        expect(c).not.toContain("nextState");
    });

    it("implement requires tests, real pasted output, a PR via gh, and forbids fabrication", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO);
        expect(c).toContain("CLAUDE.md");
        expect(c).toMatch(/test/i);
        expect(c).toMatch(/real/i);
        expect(c).toMatch(/\bgh\b/);
        expect(c).toMatch(/pull request/i);
        expect(c).toContain("prUrl");
        expect(c).toMatch(/fabricat/i);
    });
});

describe("renderReviewContract", () => {
    it("bakes in the beflow-review block and the work-item placeholders", () => {
        const c = renderReviewContract(defaultSet(), issue(), REPO);
        expect(c).toContain("beflow-review");
        expect(c).toContain("CG-42");
        expect(c).toContain("Crash on export");
        expect(c).toContain("Bug");
    });

    it("instructs the agent to use gh pr diff and forbids merging", () => {
        const c = renderReviewContract(defaultSet(), issue(), REPO);
        expect(c).toMatch(/gh pr diff/);
        expect(c).toMatch(/must NOT merge/i);
    });

    it("includes every severity level", () => {
        const c = renderReviewContract(defaultSet(), issue(), REPO);
        for (const sev of ["blocker", "major", "minor", "nit"]) {
            expect(c).toContain(sev);
        }
    });

    it("loads the review default in the PromptSet", () => {
        expect(defaultSet().review).toContain("beflow-review");
    });
});

describe("renderTask — work-item block", () => {
    it("includes the key, title, type, and description", () => {
        const t = renderTask(defaultSet(), issue(), REPO);
        expect(t).toContain("CG-42");
        expect(t).toContain("Crash on export");
        expect(t).toContain("Bug");
        expect(t).toContain("It crashes when exporting a PDF on Safari.");
    });

    it("is tracker-blind", () => {
        const t = renderTask(defaultSet(), issue(), REPO).toLowerCase();
        expect(t).not.toContain("plane");
        expect(t).not.toContain("linear");
    });

    it("handles a missing type and empty body", () => {
        const t = renderTask(defaultSet(), issue({ body: "", type: undefined }), REPO);
        expect(t).toContain("Unspecified");
        expect(t).toContain("(no description provided)");
    });
});

describe("buildPromptContext", () => {
    it("exposes the five placeholders", () => {
        const ctx = buildPromptContext(issue(), REPO);
        expect(ctx).toEqual({
            description: "It crashes when exporting a PDF on Safari.",
            key: "CG-42",
            repo: "main_repo",
            title: "Crash on export",
            type: "Bug",
        });
    });

    it("defaults type to Unspecified and empty body to a placeholder", () => {
        const ctx = buildPromptContext(issue({ body: "   ", type: undefined }), REPO);
        expect(ctx.type).toBe("Unspecified");
        expect(ctx.description).toBe("(no description provided)");
    });

    it("keeps a non-empty body untrimmed", () => {
        const ctx = buildPromptContext(issue({ body: "  keep me  " }), REPO);
        expect(ctx.description).toBe("  keep me  ");
    });
});

describe("renderTemplate", () => {
    it("substitutes every placeholder and supports repeats and inner whitespace", () => {
        const out = renderTemplate("t", "{{a}} {{ a }} and {{b}}", { a: "X", b: "Y" });
        expect(out).toBe("X X and Y");
    });

    it("throws on an unknown placeholder", () => {
        expect(() => renderTemplate("triage", "hi {{nope}}", { a: "X" })).toThrow(
            'beflow: unknown placeholder "{{nope}}" in triage prompt',
        );
    });
});

describe("loadPromptSet — override cascade", () => {
    function depsFrom(files: Record<string, string>, promptsDir?: string): PromptResolveDeps {
        return {
            configDir: "/cfg",
            exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
            home: "/home",
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

    it("project-local beats promptsDir beats the global prompts dir beats compiled default", () => {
        withXdgConfigHome((globalDir) => {
            // All three override layers provide triage; the project-local one wins.
            const set = loadPromptSet(
                depsFrom(
                    {
                        "/cfg/prompts/triage.md": "PROJECT",
                        "/custom/triage.md": "CUSTOM",
                        [join(globalDir, "prompts", "triage.md")]: "GLOBAL",
                    },
                    "/custom",
                ),
            );
            expect(set.triage).toBe("PROJECT");
        });
    });

    it("falls through to promptsDir when project-local is absent", () => {
        withXdgConfigHome((globalDir) => {
            const set = loadPromptSet(
                depsFrom(
                    {
                        "/custom/triage.md": "CUSTOM",
                        [join(globalDir, "prompts", "triage.md")]: "GLOBAL",
                    },
                    "/custom",
                ),
            );
            expect(set.triage).toBe("CUSTOM");
        });
    });

    it("falls through to the global prompts dir when project-local and promptsDir are absent", () => {
        withXdgConfigHome((globalDir) => {
            const set = loadPromptSet(depsFrom({ [join(globalDir, "prompts", "spec.md")]: "GLOBAL" }, "/custom"));
            expect(set.spec).toBe("GLOBAL");
            // Untouched names still come from the compiled defaults.
            expect(set.triage).toContain("TRIAGE");
        });
    });

    it("expands a leading ~ in promptsDir to the home dir", () => {
        const set = loadPromptSet(depsFrom({ "/home/agent-prompts/triage.md": "TILDE" }, "~/agent-prompts"));
        expect(set.triage).toBe("TILDE");
    });
});

describe("implement.md default — per-mode guidance", () => {
    it("rendered agent-owned contract contains UPDATE the existing pull request guidance for continuation items", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO);
        expect(c).toContain("UPDATE the existing pull request");
    });

    it("instructs use of a to-do tool and requires every item complete before shipping", () => {
        const set = defaultSet();
        expect(set.implement).toContain("to-do/task tool");
        expect(set.implement).toContain("every item on your to-do list is marked complete");
        const c = renderContract(defaultSet(), "implement", issue(), REPO);
        expect(c).toMatch(/every item on your to-do list is marked complete[\s\S]*commit/);
    });
});

describe("continuation.md default", () => {
    it("contains the returning-to-you header", () => {
        const set = defaultSet();
        expect(set.continuation).toContain("returning to you for continuation");
    });

    it("contains all four placeholders", () => {
        const set = defaultSet();
        expect(set.continuation).toContain("{{prior_report}}");
        expect(set.continuation).toContain("{{pr_url}}");
        expect(set.continuation).toContain("{{review_comments}}");
        expect(set.continuation).toContain("{{pr_continuation_instruction}}");
    });
});

describe("renderLinkedContext", () => {
    function ctx(over: Partial<IssueContext> = {}): IssueContext {
        return { attachments: [], ...over };
    }

    it("returns an empty string when there is no parent and no attachments", () => {
        expect(renderLinkedContext(ctx())).toBe("");
    });

    it("renders a parent-only context with the type label and body", () => {
        const out = renderLinkedContext(
            ctx({ parent: { body: "Ship the export pipeline", key: "CG-1", title: "Export epic", type: "Epic" } }),
        );
        expect(out).toContain("## Linked context");
        expect(out).toContain('Parent Epic CG-1 "Export epic":');
        expect(out).toContain("Ship the export pipeline");
        expect(out).not.toContain("Attachments");
    });

    it("falls back to 'item' and '(no description)' when the parent has no type or body", () => {
        const out = renderLinkedContext(ctx({ parent: { body: "", key: "CG-1", title: "Bare parent" } }));
        expect(out).toContain('Parent item CG-1 "Bare parent":');
        expect(out).toContain("(no description)");
    });

    it("renders an attachments-only context with each name + url", () => {
        const out = renderLinkedContext(
            ctx({
                attachments: [
                    { name: "trace.log", url: "https://x/trace" },
                    { name: "spec.pdf", url: "https://x/spec" },
                ],
            }),
        );
        expect(out).toContain("Attachments (download URLs are temporary):");
        expect(out).toContain("- trace.log (https://x/trace)");
        expect(out).toContain("- spec.pdf (https://x/spec)");
        expect(out).not.toContain("Parent");
    });

    it("renders both a parent and attachments together", () => {
        const out = renderLinkedContext(
            ctx({
                attachments: [{ name: "trace.log", url: "https://x/trace" }],
                parent: { body: "goal", key: "CG-1", title: "Epic", type: "Epic" },
            }),
        );
        expect(out).toContain('Parent Epic CG-1 "Epic":');
        expect(out).toContain("- trace.log (https://x/trace)");
    });
});

describe("renderContract — PR ownership mode", () => {
    it("agent-owned (default): implement contract contains gh pr create instruction and prUrl", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO);
        expect(c).toMatch(/\bgh\b/);
        expect(c).toContain("prUrl");
        expect(c).not.toContain("gh pr create instruction");
    });

    it("agent-owned (explicit false): implement contract contains gh and prUrl", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO, false);
        expect(c).toMatch(/open a pull request with `gh`/);
        expect(c).toContain("prUrl");
    });

    it("beflow-owned: implement contract does not instruct agent to open a PR via gh", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO, true);
        expect(c).not.toMatch(/open a pull request with `gh`/);
        expect(c).not.toContain("put the PR URL in");
    });

    it("beflow-owned: implement contract instructs agent to commit and push only", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO, true);
        expect(c).toContain("commit and push your branch");
        expect(c).toMatch(/Do NOT run `gh pr create`/);
    });

    it("beflow-owned: implement contract continuation instruction does not instruct updating the PR", () => {
        const c = renderContract(defaultSet(), "implement", issue(), REPO, true);
        expect(c).not.toContain("UPDATE the existing pull request");
        expect(c).toMatch(/do NOT run `gh pr create` or `gh pr edit`/);
    });
});

describe("renderContinuation — PR ownership mode", () => {
    function emptyContinuationCtx(): ContinuationContext {
        return { newComments: [] };
    }

    it("agent-owned (default): continuation contains UPDATE the existing pull request", () => {
        const out = renderContinuation(defaultSet(), emptyContinuationCtx());
        expect(out).toContain("UPDATE it — do not open a new one");
    });

    it("agent-owned (explicit false): continuation contains UPDATE the existing pull request", () => {
        const out = renderContinuation(defaultSet(), emptyContinuationCtx(), false);
        expect(out).toContain("UPDATE it — do not open a new one");
    });

    it("beflow-owned: continuation does not instruct agent to update the PR", () => {
        const out = renderContinuation(defaultSet(), emptyContinuationCtx(), true);
        expect(out).not.toContain("UPDATE it");
        expect(out).not.toContain("open a new one");
    });

    it("beflow-owned: continuation instructs push only and forbids gh pr commands", () => {
        const out = renderContinuation(defaultSet(), emptyContinuationCtx(), true);
        expect(out).toContain("Push your changes");
        expect(out).toMatch(/do NOT run `gh pr create` or `gh pr edit`/);
    });
});
