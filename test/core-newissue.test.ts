import { describe, expect, it } from "bun:test";

import type { AgentDriver, AgentRunResult, RunOptions } from "../src/agent/driver.ts";
import type { IssueFence } from "../src/agent/issuefence.ts";
import { loadIssueTemplate, type IssueTemplate, type IssueTemplateResolveDeps } from "../src/core/issuetemplate.ts";
import { defaultEnrichIssue, newIssue, type EnrichIssue, type NewIssueDeps } from "../src/core/newissue.ts";
import type { Issue, IssueMeta } from "../src/model/types.ts";
import type {
    BlockerRef,
    BoardState,
    Comment,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ProjectCreateResult,
    QueueFilter,
    Tracker,
} from "../src/trackers/tracker.ts";

function depsFrom(files: Record<string, string>): IssueTemplateResolveDeps {
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
    };
}

class FakeTracker implements Tracker {
    createCalls: { project: string; draft: IssueDraft }[] = [];

    async getIssue(): Promise<Issue> {
        throw new Error("not used");
    }
    async blockedBy(): Promise<BlockerRef[]> {
        return [];
    }
    async issueContext(): Promise<IssueContext> {
        return { attachments: [] };
    }
    async createIssue(project: string, draft: IssueDraft): Promise<Issue> {
        this.createCalls.push({ draft, project });
        return {
            areas: [],
            body: draft.body,
            id: "wi-new",
            key: "CG-100",
            labels: draft.labels ?? [],
            meta: {},
            priority: draft.priority,
            state: { group: "backlog", name: draft.state ?? "Backlog" },
            title: draft.title,
            type: draft.type,
        };
    }
    async activeCycleIssueIds(): Promise<Set<string> | null> {
        return null;
    }
    async listQueue(_f: QueueFilter): Promise<Issue[]> {
        return [];
    }
    async updateState(): Promise<void> {}
    async assign(): Promise<void> {}
    async addProperty(): Promise<void> {}
    async removeProperty(): Promise<void> {}
    async createProperty(): Promise<void> {}
    async deleteProperty(): Promise<void> {}
    async comment(): Promise<void> {}
    async listComments(): Promise<Comment[]> {
        return [];
    }
    async linkPR(): Promise<void> {}
    readMetadata(): IssueMeta {
        return {};
    }
    async listInbox(): Promise<IntakeItem[]> {
        return [];
    }
    async acceptInbox(): Promise<void> {}
    async inspectBoard(): Promise<BoardState> {
        return { labels: [], modules: [], states: [], types: [] };
    }
    async ensureBoard(): Promise<EnsureBoardResult> {
        return { created: [], orphans: [], pruned: [], skipped: [], updated: [], warnings: [] };
    }
    async createProject(): Promise<ProjectCreateResult> {
        throw new Error("not implemented");
    }
    async verifyAuth(): Promise<void> {}
    async findProjectId(): Promise<string | null> {
        return null;
    }
}

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
title: "[bug] {{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
  - { key: steps,   label: Steps to reproduce, type: longtext }
---
## Summary
{{summary}}
## Steps
{{steps}}
`;

const PLAIN_TEMPLATE = `---
name: plain
description: A plain task
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
---
## Summary
{{summary}}
`;

const ENRICH_TEMPLATE = `---
name: feature
description: An enriched feature
enrich: true
labels: [feature]
title: "{{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
---
## Summary
{{summary}}
`;

const ENRICH_TYPED_TEMPLATE = `---
name: feature
description: An enriched feature with a fixed type/priority
enrich: true
type: Bug
priority: high
labels: [feature]
title: "{{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
---
## Summary
{{summary}}
`;

const ENRICH_SPEC_TEMPLATE = `---
name: spec
description: An enriched spec with reserved labels set
enrich: true
agent: claude
jobKind: spec
runMode: supervised
labels: [feature]
title: "{{summary}}"
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
---
## Summary
{{summary}}
`;

const ENRICH_FALSE_TEMPLATE = `---
name: plain
description: enrich disabled
enrich: false
questions:
  - { key: summary, label: One-line summary, type: text, required: true }
---
## Summary
{{summary}}
`;

function makeDeps(over: Partial<NewIssueDeps> = {}): NewIssueDeps {
    return {
        askConfirm: async () => true,
        askQuestions: async () => ({}),
        askTemplate: async () => {
            throw new Error("askTemplate should not be called");
        },
        templateDeps: depsFrom({ "/cfg/prompts/issues/bug.md": BUG_TEMPLATE }),
        tracker: new FakeTracker(),
        ...over,
    };
}

describe("newIssue — template resolution", () => {
    it("loads the named template without calling askTemplate", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ steps: "boom", summary: "it broke" }),
            tracker,
        });
        const issue = await newIssue("CG", "bug", deps);
        expect(issue?.key).toBe("CG-100");
        expect(tracker.createCalls).toHaveLength(1);
    });

    it("calls askTemplate with the listed templates when no name is given", async () => {
        let seen: { name: string; description: string }[] = [];
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "it broke" }),
            askTemplate: async (templates) => {
                seen = templates;
                return "bug";
            },
            templateDeps: depsFrom({ "/cfg/prompts/issues/bug.md": BUG_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", undefined, deps);
        expect(seen.map((t) => t.name)).toContain("bug");
        expect(tracker.createCalls[0]?.draft.title).toBe("[bug] it broke");
    });
});

describe("newIssue — answers and body", () => {
    it("substitutes answers into the rendered body", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ steps: "1. click", summary: "crash" }),
            tracker,
        });
        await newIssue("CG", "bug", deps);
        expect(tracker.createCalls[0]?.draft.body).toBe("## Summary\ncrash\n## Steps\n1. click\n");
    });

    it("fills an omitted optional answer with empty string (no throw)", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "crash" }),
            tracker,
        });
        await newIssue("CG", "bug", deps);
        expect(tracker.createCalls[0]?.draft.body).toBe("## Summary\ncrash\n## Steps\n\n");
    });
});

describe("newIssue — title derivation", () => {
    it("renders the title pattern from answers", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "broken login" }),
            tracker,
        });
        await newIssue("CG", "bug", deps);
        expect(tracker.createCalls[0]?.draft.title).toBe("[bug] broken login");
    });

    it("falls back to the summary answer when there is no title pattern", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "plain summary" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/plain.md": PLAIN_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "plain", deps);
        expect(tracker.createCalls[0]?.draft.title).toBe("plain summary");
    });

    it("throws when neither a pattern nor a title/summary answer yields a title", async () => {
        const noTitleTemplate = `---
name: empty
description: no title
questions:
  - { key: note, label: Note, type: text }
---
{{note}}
`;
        const deps = makeDeps({
            askQuestions: async () => ({ note: "" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/empty.md": noTitleTemplate }),
        });
        expect(newIssue("CG", "empty", deps)).rejects.toThrow(/empty title/);
    });
});

describe("newIssue — label mapping", () => {
    it("appends agent/run/jobkind labels and dedupes, preserving order", async () => {
        const tpl = `---
name: bug
description: d
agent: claude
jobKind: implement
runMode: autonomous
labels: [regression, "agent:claude"]
title: "t {{summary}}"
questions:
  - { key: summary, label: S, type: text }
---
body {{summary}}
`;
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/bug.md": tpl }),
            tracker,
        });
        await newIssue("CG", "bug", deps);
        expect(tracker.createCalls[0]?.draft.labels).toEqual([
            "regression",
            "agent:claude",
            "run:autonomous",
            "jobkind:implement",
        ]);
    });

    it("adds no picker labels when the template omits agent/run/jobkind", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/plain.md": PLAIN_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "plain", deps);
        expect(tracker.createCalls[0]?.draft.labels).toBeUndefined();
    });
});

describe("newIssue — state", () => {
    it("uses the template state when set", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            tracker,
        });
        await newIssue("CG", "bug", deps);
        expect(tracker.createCalls[0]?.draft.state).toBe("Backlog");
    });

    it("uses deps.defaultState when the template has no state", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            defaultState: "Triage",
            templateDeps: depsFrom({ "/cfg/prompts/issues/plain.md": PLAIN_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "plain", deps);
        expect(tracker.createCalls[0]?.draft.state).toBe("Triage");
    });

    it("defaults to Backlog when neither template nor deps specify a state", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/plain.md": PLAIN_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "plain", deps);
        expect(tracker.createCalls[0]?.draft.state).toBe("Backlog");
    });
});

describe("newIssue — confirm gate", () => {
    it("returns null and does not create when confirm is false", async () => {
        const tracker = new FakeTracker();
        const logs: string[] = [];
        const deps = makeDeps({
            askConfirm: async () => false,
            askQuestions: async () => ({ summary: "x" }),
            log: (m) => {
                logs.push(m);
            },
            tracker,
        });
        const result = await newIssue("CG", "bug", deps);
        expect(result).toBeNull();
        expect(tracker.createCalls).toHaveLength(0);
        expect(logs).toContain("beflow: issue creation cancelled");
    });

    it("passes a preview containing title, state, type, labels and body to askConfirm", async () => {
        let preview = "";
        const deps = makeDeps({
            askConfirm: async (p) => {
                preview = p;
                return false;
            },
            askQuestions: async () => ({ summary: "crash" }),
        });
        await newIssue("CG", "bug", deps);
        expect(preview).toContain("[bug] crash");
        expect(preview).toContain("Backlog");
        expect(preview).toContain("Bug");
        expect(preview).toContain("regression");
        expect(preview).toContain("## Summary");
    });
});

describe("newIssue — happy path", () => {
    it("creates the issue once with the exact draft and returns it", async () => {
        const tracker = new FakeTracker();
        const logs: string[] = [];
        const deps = makeDeps({
            askQuestions: async () => ({ steps: "do x", summary: "broken" }),
            log: (m) => {
                logs.push(m);
            },
            tracker,
        });
        const issue = await newIssue("CG", "bug", deps);

        expect(tracker.createCalls).toHaveLength(1);
        const { project, draft } = tracker.createCalls[0] ?? { draft: undefined, project: undefined };
        expect(project).toBe("CG");
        expect(draft).toEqual({
            body: "## Summary\nbroken\n## Steps\ndo x\n",
            labels: ["regression", "agent:claude", "run:autonomous", "jobkind:implement"],
            priority: "high",
            state: "Backlog",
            title: "[bug] broken",
            type: "Bug",
        });
        expect(issue?.key).toBe("CG-100");
        expect(logs).toContain("beflow: created CG-100");
    });
});

function fenceEnrich(fence: IssueFence | null): { enrich: EnrichIssue; calls: number } {
    const state = { calls: 0 };
    const enrich: EnrichIssue = async () => {
        state.calls += 1;
        return fence;
    };
    return {
        get calls(): number {
            return state.calls;
        },
        enrich,
    };
}

describe("newIssue — enrich", () => {
    it("replaces body/title and fills type/priority/labels from the fence", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({
            body: "agent body",
            labels: ["security", "feature"],
            priority: "urgent",
            title: "agent title",
            type: "Task",
        });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        const draft = tracker.createCalls[0]?.draft;
        expect(draft?.body).toBe("agent body");
        expect(draft?.title).toBe("agent title");
        expect(draft?.type).toBe("Task");
        expect(draft?.priority).toBe("urgent");
        // template label first, fence labels unioned + deduped.
        expect(draft?.labels).toEqual(["feature", "security"]);
    });

    it("does NOT override template type/priority when the template sets them", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", priority: "low", type: "Task" });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TYPED_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        const draft = tracker.createCalls[0]?.draft;
        expect(draft?.type).toBe("Bug");
        expect(draft?.priority).toBe("high");
    });

    it("falls back to the form draft and logs when the fence is null", async () => {
        const tracker = new FakeTracker();
        const logs: string[] = [];
        const { enrich } = fenceEnrich(null);
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            log: (m) => {
                logs.push(m);
            },
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        expect(tracker.createCalls[0]?.draft.body).toBe("## Summary\nx\n");
        expect(logs).toContain("beflow: enrich produced no issue block; using the form draft");
    });

    it("does NOT call enrich for an enrich:false template", async () => {
        const tracker = new FakeTracker();
        const fence = fenceEnrich({ body: "agent body" });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich: fence.enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/plain.md": ENRICH_FALSE_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "plain", deps);
        expect(fence.calls).toBe(0);
        expect(tracker.createCalls[0]?.draft.body).toBe("## Summary\nx\n");
    });

    it("uses the form draft when deps.enrich is undefined for an enrich:true template", async () => {
        const tracker = new FakeTracker();
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        expect(tracker.createCalls[0]?.draft.body).toBe("## Summary\nx\n");
    });
});

function enrichDriver(assistantText: string): { driver: AgentDriver; seen: RunOptions[] } {
    const seen: RunOptions[] = [];
    const driver: AgentDriver = {
        cancel: async () => {},
        ensureSession: async () => {},
        run: async (opts: RunOptions): Promise<AgentRunResult> => {
            seen.push(opts);
            return {
                exitCode: 0,
                raw: [],
                report: null,
                stream: { assistantText, toolCalls: [] },
                timedOut: false,
            };
        },
    };
    return { driver, seen };
}

function loadFeatureTemplate(): IssueTemplate {
    return loadIssueTemplate("feature", depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }));
}

describe("defaultEnrichIssue", () => {
    const input = {
        answers: { summary: "broken login" },
        seedBody: "## Summary\nbroken login\n",
        seedTitle: "broken login",
    } as const;

    it("runs the driver read-only and returns the parsed fence", async () => {
        const { driver, seen } = enrichDriver(
            'Investigating...\n```beflow-issue\n{"body":"enriched body","type":"Bug"}\n```',
        );
        const enrich = defaultEnrichIssue({
            defaultAgent: "claude",
            driver,
            enrichPrompt: "answers: {{answers}} draft: {{draft}} format: {{format}} title: {{title}}",
            repoPath: "/repo/x",
            resolveAcp: () => "claude-acp",
        });
        const template = loadFeatureTemplate();
        const fence = await enrich({ ...input, template });
        expect(fence).toEqual({ body: "enriched body", type: "Bug" });

        const opts = seen[0];
        expect(opts?.oneShot).toBe(true);
        expect(opts?.runMode).toBe("supervised");
        expect(opts?.nonInteractive).toBe("deny");
        expect(opts?.cwd).toBe("/repo/x");
        expect(opts?.acpCommand).toBe("claude-acp");
    });

    it("degrades to null when the driver throws", async () => {
        const logs: string[] = [];
        const driver: AgentDriver = {
            cancel: async () => {},
            ensureSession: async () => {},
            run: async () => {
                throw new Error("boom");
            },
        };
        const enrich = defaultEnrichIssue({
            defaultAgent: "claude",
            driver,
            enrichPrompt: "{{answers}}{{draft}}{{format}}{{title}}",
            log: (m) => {
                logs.push(m);
            },
            repoPath: "/repo/x",
            resolveAcp: () => "claude-acp",
        });
        const fence = await enrich({ ...input, template: loadFeatureTemplate() });
        expect(fence).toBeNull();
        expect(logs.some((m) => m.includes("enrich agent failed"))).toBe(true);
    });
});

describe("newIssue — enrich reserved-namespace gating", () => {
    it("template jobkind wins: enrich jobkind label is dropped", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["jobkind:implement", "customer-reported"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/spec.md": ENRICH_SPEC_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "spec", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels).toContain("jobkind:spec");
        expect(labels).not.toContain("jobkind:implement");
    });

    it("template agent wins: enrich agent label is dropped", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["agent:gpt4"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/spec.md": ENRICH_SPEC_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "spec", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels).toContain("agent:claude");
        expect(labels).not.toContain("agent:gpt4");
    });

    it("template run wins: enrich run label is dropped", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["run:autonomous"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/spec.md": ENRICH_SPEC_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "spec", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels).toContain("run:supervised");
        expect(labels).not.toContain("run:autonomous");
    });

    it("open/free-form enrich labels are additive", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["customer-reported"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/spec.md": ENRICH_SPEC_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "spec", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels).toContain("customer-reported");
    });

    it("enrich fills a reserved namespace the template leaves unset", async () => {
        // ENRICH_TEMPLATE has no agent/run/jobKind set, so enrich can supply them.
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["agent:claude", "jobkind:spec"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels).toContain("agent:claude");
        expect(labels).toContain("jobkind:spec");
    });

    it("exact-duplicate labels from enrich are deduped", async () => {
        const tracker = new FakeTracker();
        const { enrich } = fenceEnrich({ body: "b", labels: ["feature", "customer-reported"] });
        const deps = makeDeps({
            askQuestions: async () => ({ summary: "x" }),
            enrich,
            templateDeps: depsFrom({ "/cfg/prompts/issues/feature.md": ENRICH_TEMPLATE }),
            tracker,
        });
        await newIssue("CG", "feature", deps);
        const labels = tracker.createCalls[0]?.draft.labels ?? [];
        expect(labels.filter((l) => l === "feature")).toHaveLength(1);
        expect(labels).toContain("customer-reported");
    });
});
