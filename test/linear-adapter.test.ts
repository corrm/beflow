import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import type { Issue } from "../src/model/types.ts";
import { LinearTracker, createLinearTracker } from "../src/trackers/linear/adapter.ts";
import type {
    CreateIssueInput,
    LinearGateway,
    ListIssuesQuery,
    StateGroupLike,
} from "../src/trackers/linear/client.ts";
import type {
    RawAttachment,
    RawBlocker,
    RawComment,
    RawIssue,
    RawLabel,
    RawWorkflowState,
} from "../src/trackers/linear/types.ts";
import { IssueNotFoundError } from "../src/trackers/tracker.ts";

const registry: Registry = {
    projects: {
        ENG: {
            default_repo: "app",
            module_repo_map: { GUI: "app" },
            name: "Engineering",
            plane_project_id: "unused-for-linear",
            repos: { app: "/x/app" },
            root: "/x",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

interface Call {
    op: string;
    args: unknown[];
}

interface FakeOptions {
    issue?: RawIssue;
    issueError?: Error;
    verifyAuthError?: Error;
    foundTeamId?: string | null;
    issues?: RawIssue[];
    triage?: RawIssue[];
    states?: RawWorkflowState[];
    labels?: RawLabel[];
    created?: RawIssue;
    blockers?: RawBlocker[];
    comments?: RawComment[];
    attachments?: RawAttachment[];
}

function fakeGateway(opts: FakeOptions = {}) {
    const calls: Call[] = [];

    const gateway: LinearGateway = {
        verifyAuth: async () => {
            calls.push({ op: "verifyAuth", args: [] });
            if (opts.verifyAuthError !== undefined) {
                throw opts.verifyAuthError;
            }
        },
        createAttachment: async (issueId, url, title) => {
            calls.push({ op: "createAttachment", args: [issueId, url, title] });
        },
        createTeam: async (input) => {
            calls.push({ op: "createTeam", args: [input] });
            return { id: "team-new" };
        },
        findTeamId: async (key) => {
            calls.push({ op: "findTeamId", args: [key] });
            return opts.foundTeamId ?? null;
        },
        createComment: async (issueId, body) => {
            calls.push({ op: "createComment", args: [issueId, body] });
        },
        createIssue: async (teamKey, input: CreateIssueInput) => {
            calls.push({ op: "createIssue", args: [teamKey, input] });
            return opts.created ?? issueRaw();
        },
        createLabel: async (teamKey: string, label: { name: string; color?: string | undefined }) => {
            calls.push({ op: "createLabel", args: [teamKey, label] });
        },
        createState: async (teamKey, state: { name: string; type: StateGroupLike; color: string }) => {
            calls.push({ op: "createState", args: [teamKey, state] });
        },
        deleteLabel: async (labelId) => {
            calls.push({ op: "deleteLabel", args: [labelId] });
        },
        getBlockers: async (issueId) => {
            calls.push({ op: "getBlockers", args: [issueId] });
            return opts.blockers ?? [];
        },
        getIssueByIdentifier: async (identifier) => {
            calls.push({ op: "getIssueByIdentifier", args: [identifier] });
            if (opts.issueError !== undefined) {
                throw opts.issueError;
            }
            if (opts.issue === undefined) {
                throw new Error("no issue configured");
            }
            return opts.issue;
        },
        listAttachments: async (issueId) => {
            calls.push({ op: "listAttachments", args: [issueId] });
            return opts.attachments ?? [];
        },
        listComments: async (issueId) => {
            calls.push({ op: "listComments", args: [issueId] });
            return opts.comments ?? [];
        },
        listIssues: async (teamKey, query?: ListIssuesQuery) => {
            calls.push({ op: "listIssues", args: [teamKey, query] });
            return opts.issues ?? [];
        },
        listLabels: async (teamKey) => {
            calls.push({ op: "listLabels", args: [teamKey] });
            return opts.labels ?? [];
        },
        listStates: async (teamKey) => {
            calls.push({ op: "listStates", args: [teamKey] });
            return opts.states ?? [];
        },
        listTriage: async (teamKey) => {
            calls.push({ op: "listTriage", args: [teamKey] });
            return opts.triage ?? [];
        },
        updateIssueAssignee: async (issueId, assigneeId) => {
            calls.push({ op: "updateIssueAssignee", args: [issueId, assigneeId] });
        },
        updateIssueLabels: async (issueId, labelIds) => {
            calls.push({ op: "updateIssueLabels", args: [issueId, labelIds] });
        },
        updateIssueState: async (issueId, stateId) => {
            calls.push({ op: "updateIssueState", args: [issueId, stateId] });
        },
    };
    return { calls, gateway };
}

function tracker(opts: FakeOptions = {}) {
    const { gateway, calls } = fakeGateway(opts);
    return { calls, tracker: new LinearTracker({ apiKeyEnv: "LINEAR_API_KEY", gateway, registry }) };
}

const STATES: RawWorkflowState[] = [
    { id: "s-bk", name: "Backlog", type: "backlog" },
    { id: "s-todo", name: "Todo", type: "unstarted" },
    { id: "s-prog", name: "In Progress", type: "started" },
    { id: "s-done", name: "Done", type: "completed" },
];

const LABELS: RawLabel[] = [
    { id: "l-bug", name: "bug" },
    { id: "l-blocked", name: "blocked" },
];

function issueRaw(overrides: Partial<RawIssue> = {}): RawIssue {
    return {
        description: "boom",
        id: "iss-1",
        identifier: "ENG-42",
        labels: [],
        priority: 2,
        state: { id: "s-todo", name: "Todo", type: "unstarted" },
        team: { id: "t1", key: "ENG" },
        title: "Crash",
        ...overrides,
    };
}

function issue(overrides: Partial<Issue> = {}): Issue {
    return {
        areas: [],
        body: "",
        id: "iss-1",
        key: "ENG-42",
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "t",
        ...overrides,
    };
}

describe("LinearTracker.getIssue", () => {
    it("resolves an issue by identifier", async () => {
        const { tracker: t, calls } = tracker({ issue: issueRaw() });
        const result = await t.getIssue("ENG-42");
        expect(result.key).toBe("ENG-42");
        expect(result.title).toBe("Crash");
        expect(result.priority).toBe("high");
        expect(calls[0]).toEqual({
            args: ["ENG-42"],
            op: "getIssueByIdentifier",
        });
    });

    it("throws on an unknown project key", async () => {
        const { tracker: t } = tracker();
        expect(t.getIssue("ZZ-1")).rejects.toThrow(/unknown project key "ZZ"/);
    });

    it("marks an issue with archivedAt set as archived", async () => {
        const { tracker: t } = tracker({ issue: issueRaw({ archivedAt: "2026-06-15T00:00:00.000Z" }) });
        const result = await t.getIssue("ENG-42");
        expect(result.archived).toBe(true);
    });

    it("leaves a non-archived issue with a falsy archived flag", async () => {
        const { tracker: t } = tracker({ issue: issueRaw() });
        const result = await t.getIssue("ENG-42");
        expect(result.archived).toBeFalsy();
    });

    it("maps a not-found gateway error to IssueNotFoundError", () => {
        const { tracker: t } = tracker({ issueError: new Error("Entity not found") });
        expect(t.getIssue("ENG-42")).rejects.toBeInstanceOf(IssueNotFoundError);
    });

    it("propagates a non-not-found gateway error unchanged", () => {
        const original = new Error("network blip");
        const { tracker: t } = tracker({ issueError: original });
        expect(t.getIssue("ENG-42")).rejects.toBe(original);
    });
});

describe("LinearTracker.blockedBy", () => {
    it("maps blockers, marking completed/cancelled as done", async () => {
        const { tracker: t, calls } = tracker({
            blockers: [
                { identifier: "ENG-1", stateType: "completed" },
                { identifier: "ENG-2", stateType: "cancelled" },
                { identifier: "ENG-3", stateType: "started" },
            ],
        });
        const refs = await t.blockedBy(issue());
        expect(refs).toEqual([
            { done: true, key: "ENG-1" },
            { done: true, key: "ENG-2" },
            { done: false, key: "ENG-3" },
        ]);
        expect(calls.find((c) => c.op === "getBlockers")).toEqual({ args: ["iss-1"], op: "getBlockers" });
    });

    it("returns an empty list when there are no blockers", async () => {
        const { tracker: t } = tracker();
        expect(await t.blockedBy(issue())).toEqual([]);
    });
});

describe("LinearTracker.listQueue", () => {
    function items(): RawIssue[] {
        return [
            issueRaw({ id: "a", priority: 4 }),
            issueRaw({ id: "b", priority: 1 }),
            issueRaw({ id: "c", priority: 2 }),
        ];
    }

    it("passes the state-name filter and priority-ranks the result", async () => {
        const { tracker: t, calls } = tracker({ issues: items() });
        const queue = await t.listQueue({ project: "ENG", state: "Todo" });
        expect(queue.map((i) => i.id)).toEqual(["b", "c", "a"]);
        expect(calls[0]).toEqual({
            args: ["ENG", { stateName: "Todo", stateType: undefined }],
            op: "listIssues",
        });
    });

    it("passes the state-group as a stateType filter", async () => {
        const { tracker: t, calls } = tracker({ issues: [] });
        await t.listQueue({ project: "ENG", stateGroup: "started" });
        expect(calls[0]).toEqual({
            args: ["ENG", { stateName: undefined, stateType: "started" }],
            op: "listIssues",
        });
    });
});

describe("LinearTracker.updateState", () => {
    it("resolves the state id by name and updates", async () => {
        const { tracker: t, calls } = tracker({ states: STATES });
        await t.updateState(issue(), "In Progress");
        expect(calls.find((c) => c.op === "updateIssueState")).toEqual({
            args: ["iss-1", "s-prog"],
            op: "updateIssueState",
        });
    });

    it("throws on an unknown state name", async () => {
        const { tracker: t } = tracker({ states: STATES });
        expect(t.updateState(issue(), "Nope")).rejects.toThrow(/unknown state name "Nope"/);
    });
});

describe("LinearTracker.assign", () => {
    it("updates the issue assignee via the gateway", async () => {
        const { tracker: t, calls } = tracker();
        await t.assign(issue(), "u-1");
        expect(calls.find((c) => c.op === "updateIssueAssignee")).toEqual({
            args: ["iss-1", "u-1"],
            op: "updateIssueAssignee",
        });
    });
});

describe("LinearTracker.addProperty", () => {
    it("unions existing label ids with the new one", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS, states: STATES });
        await t.addProperty(issue({ labels: ["bug"] }), "blocked");
        expect(calls.find((c) => c.op === "updateIssueLabels")).toEqual({
            args: ["iss-1", ["l-bug", "l-blocked"]],
            op: "updateIssueLabels",
        });
    });

    it("throws when the new label name is unknown", async () => {
        const { tracker: t } = tracker({ labels: LABELS, states: STATES });
        expect(t.addProperty(issue(), "nonexistent")).rejects.toThrow(/unknown label name "nonexistent"/);
    });
});

describe("LinearTracker.removeProperty", () => {
    it("updates the issue with the named label id removed", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS, states: STATES });
        await t.removeProperty(issue({ labels: ["bug", "blocked"] }), "blocked");
        expect(calls.find((c) => c.op === "updateIssueLabels")).toEqual({
            args: ["iss-1", ["l-bug"]],
            op: "updateIssueLabels",
        });
    });

    it("no-ops when the label is not present on the issue", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS, states: STATES });
        await t.removeProperty(issue({ labels: ["bug"] }), "blocked");
        expect(calls.some((c) => c.op === "updateIssueLabels")).toBe(false);
    });
});

describe("LinearTracker.createProperty", () => {
    it("calls createLabel when the label is absent", async () => {
        const { tracker: t, calls } = tracker({ labels: [{ id: "l-bug", name: "bug" }] });
        await t.createProperty("ENG", "urgent", { color: "#f00" });
        expect(calls.find((c) => c.op === "createLabel")).toEqual({
            args: ["ENG", { color: "#f00", name: "urgent" }],
            op: "createLabel",
        });
    });

    it("no-ops (no createLabel) when the label already exists", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS });
        await t.createProperty("ENG", "bug");
        expect(calls.some((c) => c.op === "createLabel")).toBe(false);
    });
});

describe("LinearTracker.deleteProperty", () => {
    it("deletes the label by id when it exists", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS });
        await t.deleteProperty("ENG", "bug");
        expect(calls.find((c) => c.op === "deleteLabel")).toEqual({ args: ["l-bug"], op: "deleteLabel" });
    });

    it("no-ops (no deleteLabel) when the label is absent", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS });
        await t.deleteProperty("ENG", "nonexistent");
        expect(calls.some((c) => c.op === "deleteLabel")).toBe(false);
    });
});

describe("LinearTracker.comment and linkPR", () => {
    it("passes markdown with the beflow marker appended", async () => {
        const { tracker: t, calls } = tracker();
        await t.comment(issue(), "**bold**\n\npara");
        expect(calls.find((c) => c.op === "createComment")).toEqual({
            args: ["iss-1", "**bold**\n\npara\n\n— beflow"],
            op: "createComment",
        });
    });

    it("does not post a comment whose marked body already exists (replayed writeback)", async () => {
        const { tracker: t, calls } = tracker({
            comments: [{ body: "done\n\n— beflow", createdAt: "2026-06-15T00:00:00.000Z", id: "c-1" }],
        });
        await t.comment(issue(), "done");
        expect(calls.some((c) => c.op === "createComment")).toBe(false);
    });

    it("creates an attachment with the provided title", async () => {
        const { tracker: t, calls } = tracker();
        await t.linkPR(issue(), "http://pr", "My PR");
        expect(calls.find((c) => c.op === "createAttachment")).toEqual({
            args: ["iss-1", "http://pr", "My PR"],
            op: "createAttachment",
        });
    });

    it("defaults the attachment title to Pull Request", async () => {
        const { tracker: t, calls } = tracker();
        await t.linkPR(issue(), "http://pr");
        expect(calls.find((c) => c.op === "createAttachment")).toEqual({
            args: ["iss-1", "http://pr", "Pull Request"],
            op: "createAttachment",
        });
    });

    it("does not attach a PR url that is already linked (replayed writeback)", async () => {
        const { tracker: t, calls } = tracker({
            attachments: [{ id: "att-1", title: "Pull Request", url: "http://pr" }],
        });
        await t.linkPR(issue(), "http://pr");
        expect(calls.some((c) => c.op === "createAttachment")).toBe(false);
    });
});

describe("LinearTracker.listComments", () => {
    it("strips the marker, flags bot comments, and sorts by createdAt", async () => {
        const { tracker: t } = tracker({
            comments: [
                { authorId: "u-2", body: "second", createdAt: "2026-06-16T00:00:00.000Z", id: "c-2" },
                { authorId: "bot", body: "done\n\n— beflow", createdAt: "2026-06-15T00:00:00.000Z", id: "c-1" },
            ],
        });
        const result = await t.listComments(issue());
        expect(result).toEqual([
            { authorId: "bot", body: "done", createdAt: "2026-06-15T00:00:00.000Z", id: "c-1", isBot: true },
            { authorId: "u-2", body: "second", createdAt: "2026-06-16T00:00:00.000Z", id: "c-2", isBot: false },
        ]);
    });

    it("omits authorId when the comment has no author", async () => {
        const { tracker: t } = tracker({
            comments: [{ body: "anon", createdAt: "2026-06-15T00:00:00.000Z", id: "c-1" }],
        });
        const [comment] = await t.listComments(issue());
        expect(comment).toEqual({ body: "anon", createdAt: "2026-06-15T00:00:00.000Z", id: "c-1", isBot: false });
    });
});

describe("LinearTracker.inspectBoard", () => {
    it("returns state + label names with empty modules/types", async () => {
        const { tracker: t } = tracker({ labels: LABELS, states: STATES });
        const board = await t.inspectBoard("ENG");
        expect(board).toEqual({
            labels: ["bug", "blocked"],
            modules: [],
            states: ["Backlog", "Todo", "In Progress", "Done"],
            types: [],
        });
    });
});

describe("LinearTracker.issueContext", () => {
    it("returns an empty context (linked-context fetch is Plane-only today)", async () => {
        const { tracker: t } = tracker();
        const ctx = await t.issueContext(issue());
        expect(ctx).toEqual({ attachments: [] });
    });
});

describe("LinearTracker inbox", () => {
    it("listInbox maps triage issues", async () => {
        const { tracker: t } = tracker({
            triage: [issueRaw({ id: "iss-9", priority: 4, title: "Idea" })],
        });
        const inbox = await t.listInbox("ENG");
        expect(inbox[0]).toEqual({
            body: "boom",
            id: "iss-9",
            issueId: "iss-9",
            priority: "low",
            status: 0,
            title: "Idea",
        });
    });

    it("acceptInbox moves the issue to the first backlog-type state", async () => {
        const { tracker: t, calls } = tracker({ states: STATES });
        await t.acceptInbox("ENG", {
            body: "",
            id: "iss-9",
            issueId: "iss-9",
            status: 0,
            title: "t",
        });
        expect(calls.find((c) => c.op === "updateIssueState")).toEqual({
            args: ["iss-9", "s-bk"],
            op: "updateIssueState",
        });
    });

    it("acceptInbox throws when no backlog state exists", async () => {
        const { tracker: t } = tracker({
            states: [{ id: "s-todo", name: "Todo", type: "unstarted" }],
        });
        expect(
            t.acceptInbox("ENG", {
                body: "",
                id: "iss-9",
                issueId: "iss-9",
                status: 0,
                title: "t",
            }),
        ).rejects.toThrow(/no backlog-type state/);
    });
});

describe("LinearTracker.ensureBoard", () => {
    const template = {
        labels: [{ name: "bug" }, { name: "tech-debt" }],
        modules: [{ name: "GUI" }],
        states: [
            { name: "Todo", color: "#fff", group: "unstarted" as const },
            { name: "In Review", color: "#ff0", group: "started" as const },
        ],
        types: [{ name: "Bug" }],
    };

    it("creates missing states/labels, skips existing, warns on modules+types", async () => {
        const { tracker: t, calls } = tracker({
            labels: [{ id: "l-bug", name: "bug" }],
            states: [{ id: "s-todo", name: "Todo", type: "unstarted" }],
        });
        const result = await t.ensureBoard("ENG", template);

        expect(result.created.sort()).toEqual(["label:tech-debt", "state:In Review"].sort());
        expect(result.skipped.sort()).toEqual(["label:bug", "state:Todo"].sort());
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings.join(" ")).toMatch(/modules?/);
        expect(result.warnings.join(" ")).toMatch(/work-item types/);

        const created = calls.filter((c) => c.op === "createState" || c.op === "createLabel");
        expect(created).toHaveLength(2);
        expect(calls.find((c) => c.op === "createState")).toEqual({
            args: ["ENG", { name: "In Review", type: "started", color: "#ff0" }],
            op: "createState",
        });
    });

    it("does not create a duplicate when the team already has Linear's default 'Canceled' state", async () => {
        const cancelledTemplate = {
            labels: [],
            modules: [],
            states: [{ name: "Cancelled", color: "#aaa", group: "cancelled" as const }],
            types: [],
        };
        const { tracker: t, calls } = tracker({
            labels: [],
            states: [{ id: "s-canceled", name: "Canceled", type: "cancelled" }],
        });
        const result = await t.ensureBoard("ENG", cancelledTemplate);

        expect(result.skipped).toContain("state:Cancelled");
        const createStateCalls = calls.filter(
            (c) =>
                c.op === "createState" &&
                typeof c.args[1] === "object" &&
                c.args[1] !== null &&
                "name" in c.args[1] &&
                (c.args[1] as Record<string, unknown>).name === "Cancelled",
        );
        expect(createStateCalls).toHaveLength(0);
    });
});

describe("LinearTracker.createIssue", () => {
    it("maps the priority string→int, resolves label/state names→ids, and returns a mapped Issue", async () => {
        const { tracker: t, calls } = tracker({
            created: issueRaw({ id: "iss-new", identifier: "ENG-99", title: "New thing" }),
            labels: LABELS,
            states: STATES,
        });

        const issue = await t.createIssue("ENG", {
            assigneeId: "u-1",
            body: "desc",
            labels: ["bug"],
            priority: "high",
            state: "In Progress",
            title: "New thing",
        });

        const call = calls.find((c) => c.op === "createIssue")!;
        expect(call.args[0]).toBe("ENG");
        expect(call.args[1]).toEqual({
            assigneeId: "u-1",
            description: "desc",
            labelIds: ["l-bug"],
            priority: 2,
            stateId: "s-prog",
            title: "New thing",
        });
        expect(issue.key).toBe("ENG-99");
        expect(issue.title).toBe("New thing");
    });

    it("carries draft.type as a label (Linear has no native work-item type)", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS, states: STATES });
        await t.createIssue("ENG", { body: "d", labels: ["blocked"], title: "x", type: "bug" });
        const call = calls.find((c) => c.op === "createIssue")!;
        expect(call.args[1]).toMatchObject({ labelIds: ["l-blocked", "l-bug"] });
    });

    it("omits priority/labels/state when the draft does not provide them", async () => {
        const { tracker: t, calls } = tracker({ labels: LABELS, states: STATES });
        await t.createIssue("ENG", { body: "d", title: "x" });
        const call = calls.find((c) => c.op === "createIssue")!;
        expect(call.args[1]).toEqual({ description: "d", priority: undefined, title: "x" });
    });

    it("throws on an unknown label name", async () => {
        const { tracker: t } = tracker({ labels: LABELS, states: STATES });
        expect(t.createIssue("ENG", { body: "d", labels: ["ghost"], title: "x" })).rejects.toThrow(
            /unknown label name "ghost"/,
        );
    });

    it("throws on an unknown state name", async () => {
        const { tracker: t } = tracker({ labels: LABELS, states: STATES });
        expect(t.createIssue("ENG", { body: "d", state: "Ghost", title: "x" })).rejects.toThrow(
            /unknown state name "Ghost"/,
        );
    });
});

describe("LinearTracker.createProject", () => {
    it("calls gateway.createTeam with name and key=identifier and returns trackerProjectId", async () => {
        const { tracker: t, calls } = tracker({});
        const result = await t.createProject({ identifier: "NP", name: "New Project" });
        const call = calls.find((c) => c.op === "createTeam")!;
        expect(call.args[0]).toEqual({ key: "NP", name: "New Project" });
        expect(result).toEqual({ trackerProjectId: "team-new" });
    });
});

describe("LinearTracker.findProjectId", () => {
    it("returns the team id when a team with the identifier exists", async () => {
        const { tracker: t, calls } = tracker({ foundTeamId: "team-cg" });
        expect(await t.findProjectId("cg")).toBe("team-cg");
        const call = calls.find((c) => c.op === "findTeamId");
        expect(call?.args[0]).toBe("CG");
    });

    it("returns null when no team matches", async () => {
        const { tracker: t } = tracker({ foundTeamId: null });
        expect(await t.findProjectId("ZZ")).toBeNull();
    });
});

describe("LinearTracker.verifyAuth", () => {
    it("resolves when the gateway probe succeeds", async () => {
        const { tracker: t, calls } = tracker();
        await t.verifyAuth();
        expect(calls.some((c) => c.op === "verifyAuth")).toBe(true);
    });

    it("throws an actionable error naming the env var when the gateway probe rejects", () => {
        const { tracker: t } = tracker({ verifyAuthError: new Error("401 unauthorized") });
        expect(t.verifyAuth()).rejects.toThrow(/Linear token invalid.*LINEAR_API_KEY/s);
    });
});

describe("createLinearTracker", () => {
    const config: Config = {
        agents: {},
        agent: "claude",
        onManualMove: "yield",
        runMode: "supervised",
        tracker: "linear",
        trackers: { linear: { apiKeyEnv: "LINEAR_API_KEY" } },
    };

    it("reads the API key from env", () => {
        const t = createLinearTracker(config, registry, { LINEAR_API_KEY: "abc" });
        expect(t).toBeInstanceOf(LinearTracker);
    });

    it("throws when the API key env var is unset", () => {
        expect(() => createLinearTracker(config, registry, {})).toThrow(/LINEAR_API_KEY.* is unset/);
    });
});
