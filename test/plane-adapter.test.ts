import { describe, expect, it } from "bun:test";

import type { Config, Registry } from "../src/config/schema.ts";
import type { Issue } from "../src/model/types.ts";
import { PlaneTracker, createPlaneTracker, verifyPlaneConfig } from "../src/trackers/plane/adapter.ts";
import { PlaneClient } from "../src/trackers/plane/client.ts";
import type { FetchLike } from "../src/trackers/plane/client.ts";
import { IssueNotFoundError } from "../src/trackers/tracker.ts";

const PID = "00000000-0000-4000-8000-000000000003";

const registry: Registry = {
    projects: {
        CG: {
            default_repo: "api",
            module_repo_map: { GUI: "api" },
            name: "My App",
            plane_project_id: PID,
            repos: { api: "/x/bin" },
            root: "/x",
        },
    },
    workspace: { id: "w", slug: "your-workspace" },
};

type RequestBody = Record<string, unknown>;

interface RouteHandler {
    match: (url: string, method: string) => boolean;
    respond: (url: string, method: string, body: RequestBody | undefined) => Response;
}

interface Call {
    url: string;
    method: string;
    body: RequestBody | undefined;
}

function isRecord(_v: object): _v is Record<string, unknown> {
    return true;
}

function parseBody(text: string | null): RequestBody | undefined {
    if (text === null) {
        return undefined;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !isRecord(parsed)) {
        return undefined;
    }
    return parsed;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status,
    });
}

function page(results: unknown[]): Response {
    return json({ next_cursor: "", next_page_results: false, results });
}

function router(routes: RouteHandler[]): { fetch: FetchLike; calls: Call[] } {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
        const method = init?.method ?? "GET";
        const bodyText = typeof init?.body === "string" ? init.body : null;
        const body = parseBody(bodyText);
        calls.push({ body, method, url });
        for (const route of routes) {
            if (route.match(url, method)) {
                return route.respond(url, method, body);
            }
        }
        return new Response(`no route for ${method} ${url}`, { status: 404 });
    };
    return { calls, fetch };
}

function tracker(routes: RouteHandler[]) {
    const { fetch, calls } = router(routes);
    const client = new PlaneClient({
        apiKey: "k",
        fetch,
        workspaceSlug: "your-workspace",
    });
    return {
        calls,
        tracker: new PlaneTracker({
            auth: { apiKeyEnv: "PLANE_API_KEY", workspaceSlug: "your-workspace" },
            client,
            registry,
        }),
    };
}

const STATES = [
    { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
    { color: "#0f0", group: "started", id: "s-prog", name: "In Progress" },
    { color: "#00f", group: "completed", id: "s-done", name: "Done" },
];

const cacheRoutes: RouteHandler[] = [
    { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
    { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([{ id: "l1", name: "bug" }]) },
    { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([{ id: "m1", name: "GUI" }]) },
    // Work-item-types is a BARE ARRAY endpoint (not paginated) — see client.listTypes
    {
        match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
        respond: () => json([{ id: "ty-bug", name: "Bug" }]),
    },
];

describe("PlaneTracker.getIssue", () => {
    it("resolves CG-42 via by-identifier endpoint", async () => {
        const { tracker: t, calls } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/CG-42/"),
                respond: () =>
                    json({
                        description_stripped: "boom",
                        id: "wi-42",
                        labels: [{ id: "l1", name: "bug" }],
                        name: "Crash",
                        priority: "high",
                        sequence_id: 42,
                        state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
                    }),
            },
        ]);
        const issue = await t.getIssue("CG-42");
        expect(issue.key).toBe("CG-42");
        expect(issue.title).toBe("Crash");
        expect(issue.state.name).toBe("Todo");
        expect(calls.some((c) => c.url.includes("/work-items/CG-42/"))).toBe(true);
    });

    it("throws on unknown project key", async () => {
        const { tracker: t } = tracker(cacheRoutes);
        expect(t.getIssue("ZZ-1")).rejects.toThrow(/unknown project key "ZZ"/);
    });

    it("throws IssueNotFoundError when the work item 404s (deleted)", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/CG-42/"),
                respond: () => new Response("not found", { status: 404 }),
            },
        ]);
        let caught: unknown;
        try {
            await t.getIssue("CG-42");
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(IssueNotFoundError);
        if (caught instanceof IssueNotFoundError) {
            expect(caught.key).toBe("CG-42");
        }
    });

    it("bubbles a transient (non-404/410) failure as its original error, not IssueNotFoundError", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/CG-42/"),
                respond: () => new Response("boom", { status: 500 }),
            },
        ]);
        let caught: unknown;
        try {
            await t.getIssue("CG-42");
        } catch (err) {
            caught = err;
        }
        expect(caught).not.toBeInstanceOf(IssueNotFoundError);
        expect(caught).toBeInstanceOf(Error);
        if (caught instanceof Error) {
            expect(caught.message).toMatch(/failed with 500/);
        }
    });

    it("marks an archived work item (archived_at set) as archived", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/CG-42/"),
                respond: () =>
                    json({
                        archived_at: "2026-06-15T00:00:00Z",
                        description_stripped: "boom",
                        id: "wi-42",
                        name: "Crash",
                        sequence_id: 42,
                        state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
                    }),
            },
        ]);
        const issue = await t.getIssue("CG-42");
        expect(issue.archived).toBe(true);
    });

    it("leaves a normal (non-archived) work item with a falsy archived flag", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/CG-42/"),
                respond: () =>
                    json({
                        description_stripped: "boom",
                        id: "wi-42",
                        name: "Crash",
                        sequence_id: 42,
                        state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
                    }),
            },
        ]);
        const issue = await t.getIssue("CG-42");
        expect(issue.archived).toBeFalsy();
    });
});

describe("IssueNotFoundError", () => {
    it("is an Error subclass that carries the key", () => {
        const err = new IssueNotFoundError("CG-42");
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(IssueNotFoundError);
        expect(err.key).toBe("CG-42");
        expect(err.name).toBe("IssueNotFoundError");
        expect(err.message).toContain("CG-42");
    });
});

function workItems() {
    return [
        {
            id: "a",
            name: "low task",
            priority: "low",
            sequence_id: 1,
            state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
        },
        {
            id: "b",
            name: "urgent task",
            priority: "urgent",
            sequence_id: 2,
            state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
        },
        {
            id: "c",
            name: "done task",
            priority: "high",
            sequence_id: 3,
            state: { color: "#00f", group: "completed", id: "s-done", name: "Done" },
        },
    ];
}

describe("PlaneTracker.listQueue", () => {
    it("filters by state name and priority-ranks", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/?"),
                respond: () => page(workItems()),
            },
        ]);
        const queue = await t.listQueue({ project: "CG", state: "Todo" });
        expect(queue.map((i) => i.id)).toEqual(["b", "a"]);
    });

    it("filters by state group", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/?"),
                respond: () => page(workItems()),
            },
        ]);
        const queue = await t.listQueue({ project: "CG", stateGroup: "completed" });
        expect(queue.map((i) => i.id)).toEqual(["c"]);
    });
});

describe("PlaneTracker.updateState", () => {
    function issue(): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels: [],
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
        };
    }

    it("resolves state uuid by name and PATCHes {state: uuid}", async () => {
        const { tracker: t, calls } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.updateState(issue(), "In Progress");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.body).toEqual({ state: "s-prog" });
    });

    it("throws on unknown state name", async () => {
        const { tracker: t } = tracker(cacheRoutes);
        expect(t.updateState(issue(), "Nope")).rejects.toThrow(/unknown state name "Nope"/);
    });
});

describe("PlaneTracker.assign", () => {
    function issue(): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels: [],
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
        };
    }

    it("PATCHes the work item with {assignees: [id]}", async () => {
        const { tracker: t, calls } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.assign(issue(), "u-1");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.url).toContain("/work-items/wi-42/");
        expect(patch.body).toEqual({ assignees: ["u-1"] });
    });
});

describe("PlaneTracker.addProperty", () => {
    const labelRoutes: RouteHandler[] = [
        { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
        {
            match: (u, m) => m === "GET" && u.includes("/labels/"),
            respond: () =>
                page([
                    { id: "l-bug", name: "bug" },
                    { id: "l-blocked", name: "blocked" },
                ]),
        },
        { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([{ id: "m1", name: "GUI" }]) },
        {
            match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
            respond: () => json([{ id: "ty-bug", name: "Bug" }]),
        },
    ];

    function issue(labels: string[]): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels,
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
        };
    }

    it("PATCHes the union of existing label uuids and the new one", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.addProperty(issue(["bug"]), "blocked");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.body).toEqual({ labels: ["l-bug", "l-blocked"] });
    });

    it("skips names not in the cache (system labels) without throwing", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.addProperty(issue(["mystery-system-label"]), "blocked");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.body).toEqual({ labels: ["l-blocked"] });
    });

    it("does not duplicate the uuid when the label is already present", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.addProperty(issue(["blocked", "bug"]), "blocked");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.body).toEqual({ labels: ["l-blocked", "l-bug"] });
    });

    it("throws when the label name is unknown in the project", async () => {
        const { tracker: t } = tracker(labelRoutes);
        expect(t.addProperty(issue(["bug"]), "nonexistent")).rejects.toThrow(/unknown label name "nonexistent"/);
    });
});

describe("PlaneTracker.removeProperty", () => {
    const labelRoutes: RouteHandler[] = [
        { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
        {
            match: (u, m) => m === "GET" && u.includes("/labels/"),
            respond: () =>
                page([
                    { id: "l-bug", name: "bug" },
                    { id: "l-blocked", name: "blocked" },
                ]),
        },
        { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([{ id: "m1", name: "GUI" }]) },
        {
            match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
            respond: () => json([{ id: "ty-bug", name: "Bug" }]),
        },
    ];

    function issue(labels: string[]): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels,
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
        };
    }

    it("PATCHes the work item with the named label uuid removed", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.removeProperty(issue(["bug", "blocked"]), "blocked");
        const patch = calls.find((c) => c.method === "PATCH")!;
        expect(patch.body).toEqual({ labels: ["l-bug"] });
    });

    it("no-ops (no PATCH) when the label is not present on the issue", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.removeProperty(issue(["bug"]), "blocked");
        expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });

    it("no-ops (no PATCH) when the label name is unknown in the project", async () => {
        const { tracker: t, calls } = tracker([
            ...labelRoutes,
            {
                match: (u, m) => m === "PATCH" && u.includes("/work-items/wi-42/"),
                respond: () => json({ id: "wi-42" }),
            },
        ]);
        await t.removeProperty(issue(["bug"]), "nonexistent");
        expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    });
});

describe("PlaneTracker.createProperty", () => {
    const baseRoutes: RouteHandler[] = [
        { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
        { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
        {
            match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
            respond: () => json([]),
        },
    ];

    it("POSTs a new label when the name is absent", async () => {
        const { tracker: t, calls } = tracker([
            ...baseRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l-bug", name: "bug" }]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/labels/"),
                respond: () => json({ id: "l-new", name: "urgent" }),
            },
        ]);
        await t.createProperty("CG", "urgent", { color: "#f00" });
        const post = calls.find((c) => c.method === "POST" && c.url.includes("/labels/"))!;
        expect(post.body).toMatchObject({ name: "urgent", color: "#f00" });
    });

    it("no-ops (no POST) when a label with that name already exists", async () => {
        const { tracker: t, calls } = tracker([
            ...baseRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l-bug", name: "bug" }]),
            },
        ]);
        await t.createProperty("CG", "bug");
        expect(calls.some((c) => c.method === "POST" && c.url.includes("/labels/"))).toBe(false);
    });
});

describe("PlaneTracker.deleteProperty", () => {
    const baseRoutes: RouteHandler[] = [
        { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
        { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
        {
            match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
            respond: () => json([]),
        },
    ];

    it("DELETEs the label by id when found", async () => {
        const { tracker: t, calls } = tracker([
            ...baseRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l-blocked", name: "blocked" }]),
            },
            {
                match: (u, m) => m === "DELETE" && u.includes("/labels/l-blocked/"),
                respond: () => new Response(null, { status: 204 }),
            },
        ]);
        await t.deleteProperty("CG", "blocked");
        expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/labels/l-blocked/"))).toBe(true);
    });

    it("no-ops (no DELETE) when no label with that name exists", async () => {
        const { tracker: t, calls } = tracker([
            ...baseRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l-bug", name: "bug" }]),
            },
        ]);
        await t.deleteProperty("CG", "nonexistent");
        expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    });
});

function baseIssue(): Issue {
    return {
        areas: [],
        body: "",
        id: "wi-42",
        key: "CG-42",
        labels: [],
        meta: {},
        state: { group: "unstarted", name: "Todo" },
        title: "t",
    };
}

describe("PlaneTracker.comment and linkPR", () => {
    it("comment posts comment_html with the beflow marker appended", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () => page([]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/comments/"),
                respond: () => json({ id: "c" }),
            },
        ]);
        await t.comment(baseIssue(), "hello\n\nworld");
        const post = calls.find((c) => c.method === "POST");
        expect(post!.body).toEqual({ comment_html: "<p>hello</p><p>world</p><p>— beflow</p>" });
    });

    it("comment is idempotent: skips POST when the same marked comment already exists", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () => page([{ comment_html: "<p>hello</p><p>world</p><p>— beflow</p>", id: "c" }]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/comments/"),
                respond: () => json({ id: "c2" }),
            },
        ]);
        await t.comment(baseIssue(), "hello\n\nworld");
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("linkPR posts url + provided title when not already linked", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/links/"),
                respond: () => page([]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/links/"),
                respond: () => json({ id: "lk" }),
            },
        ]);
        await t.linkPR(baseIssue(), "http://pr", "My PR");
        const post = calls.find((c) => c.method === "POST");
        expect(post!.body).toEqual({ title: "My PR", url: "http://pr" });
    });

    it("linkPR defaults title to Pull Request", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/links/"),
                respond: () => page([]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/links/"),
                respond: () => json({ id: "lk" }),
            },
        ]);
        await t.linkPR(baseIssue(), "http://pr");
        const post = calls.find((c) => c.method === "POST");
        expect(post!.body).toEqual({ title: "Pull Request", url: "http://pr" });
    });

    it("linkPR is idempotent: skips POST when the URL is already linked", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/links/"),
                respond: () => page([{ id: "lk", title: "Pull Request", url: "http://pr" }]),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/links/"),
                respond: () => json({ id: "lk2" }),
            },
        ]);
        await t.linkPR(baseIssue(), "http://pr");
        expect(calls.some((c) => c.method === "POST")).toBe(false);
    });
});

describe("PlaneTracker.listComments", () => {
    it("maps raw comments to Comment objects and orders by createdAt ascending", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () =>
                    page([
                        {
                            comment_html: "<p>second</p>",
                            comment_stripped: "second",
                            created_at: "2024-02-01T00:00:00Z",
                            created_by: "u-2",
                            id: "c2",
                        },
                        {
                            comment_html: "<p>first</p>",
                            comment_stripped: "first",
                            created_at: "2024-01-01T00:00:00Z",
                            created_by: "u-1",
                            id: "c1",
                        },
                    ]),
            },
        ]);
        const comments = await t.listComments(baseIssue());
        expect(comments).toHaveLength(2);
        expect(comments[0]!.id).toBe("c1");
        expect(comments[0]!.createdAt).toBe("2024-01-01T00:00:00Z");
        expect(comments[0]!.authorId).toBe("u-1");
        expect(comments[1]!.id).toBe("c2");
    });

    it("sets isBot true for a comment that contains the marker, false for human", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () =>
                    page([
                        {
                            comment_html: "<p>bot reply</p><p>— beflow</p>",
                            comment_stripped: "bot reply\n\n— beflow",
                            created_at: "2024-01-01T00:00:00Z",
                            id: "bot",
                        },
                        {
                            comment_html: "<p>human reply</p>",
                            comment_stripped: "human reply",
                            created_at: "2024-01-02T00:00:00Z",
                            id: "human",
                        },
                    ]),
            },
        ]);
        const comments = await t.listComments(baseIssue());
        const bot = comments.find((c) => c.id === "bot")!;
        const human = comments.find((c) => c.id === "human")!;
        expect(bot.isBot).toBe(true);
        expect(human.isBot).toBe(false);
    });

    it("strips the marker from body for a bot comment", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () =>
                    page([
                        {
                            comment_html: "<p>done!</p><p>— beflow</p>",
                            comment_stripped: "done!\n\n— beflow",
                            created_at: "2024-01-01T00:00:00Z",
                            id: "c1",
                        },
                    ]),
            },
        ]);
        const [comment] = await t.listComments(baseIssue());
        expect(comment!.body).toBe("done!");
    });

    it("falls back to tag-stripping comment_html when comment_stripped is absent", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () =>
                    page([
                        {
                            comment_html: "<p>only html</p>",
                            created_at: "2024-01-01T00:00:00Z",
                            id: "c1",
                        },
                    ]),
            },
        ]);
        const [comment] = await t.listComments(baseIssue());
        expect(comment!.body).toBe("only html");
        expect(comment!.isBot).toBe(false);
    });

    it("decodes HTML entities in the tag-strip fallback when comment_stripped is absent", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/comments/"),
                respond: () =>
                    page([
                        {
                            comment_html: "<p>a &amp;amp; b &amp;lt; c &amp;gt; d</p>",
                            created_at: "2024-01-01T00:00:00Z",
                            id: "c1",
                        },
                    ]),
            },
        ]);
        const [comment] = await t.listComments(baseIssue());
        expect(comment!.body).toBe("a &amp; b &lt; c &gt; d");
    });
});

describe("PlaneTracker inbox", () => {
    it("listInbox maps intake items", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/intake-issues/"),
                respond: () =>
                    page([
                        {
                            id: "in-1",
                            issue: "wi-9",
                            issue_detail: { description: "d", id: "wi-9", name: "Idea", priority: "low" },
                            status: -2,
                        },
                    ]),
            },
        ]);
        const inbox = await t.listInbox("CG");
        expect(inbox[0]).toEqual({
            body: "d",
            id: "in-1",
            issueId: "wi-9",
            priority: "low",
            status: -2,
            title: "Idea",
        });
    });

    it("acceptInbox PATCHes status:1 via issue id + /status/ suffix", async () => {
        // Regression: old call used the intake record id (in-1) and no /status/ suffix —
        // Plane rejects that with HTTP 400. The correct path uses the issue id (wi)
        // with the /status/ suffix. Verified live 2026-06-18.
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "PATCH" && u.includes("/intake-issues/wi/status/"),
                respond: () => json({ id: "wi" }),
            },
        ]);
        await t.acceptInbox("CG", {
            body: "",
            id: "in-1",
            issueId: "wi",
            status: -2,
            title: "t",
        });
        expect(calls[0]!.body).toEqual({ status: 1 });
        expect(calls[0]!.url).toContain("/intake-issues/wi/status/");
    });
});

describe("PlaneTracker.inspectBoard", () => {
    it("returns name arrays for states, labels, modules, and types", async () => {
        const { tracker: t } = tracker(cacheRoutes);
        const board = await t.inspectBoard("CG");
        expect(board.states).toEqual(["Todo", "In Progress", "Done"]);
        expect(board.labels).toEqual(["bug"]);
        expect(board.modules).toEqual(["GUI"]);
        expect(board.types).toEqual(["Bug"]);
    });

    it("tolerates the work-item-types endpoint being off", async () => {
        const { tracker: t } = tracker([
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l1", name: "bug" }]),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/modules/"),
                respond: () => page([{ id: "m1", name: "GUI" }]),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
                respond: () => new Response("feature disabled", { status: 400 }),
            },
        ]);
        const board = await t.inspectBoard("CG");
        expect(board.types).toEqual([]);
        expect(board.states).toEqual(["Todo", "In Progress", "Done"]);
    });
});

describe("PlaneTracker.ensureBoard", () => {
    const template = {
        labels: [{ name: "bug" }, { name: "tech-debt" }],
        modules: [{ name: "GUI" }, { name: "Website" }],
        states: [
            { name: "Todo", color: "#fff", group: "unstarted" as const },
            { name: "In Review", color: "#ff0", group: "started" as const },
        ],
        types: [{ name: "Bug" }],
    };

    const featuresRoute: RouteHandler = {
        match: (u, m) => m === "PATCH" && /\/projects\/[^/]+\/$/.test(u),
        respond: () => new Response(null, { status: 204 }),
    };

    it("creates missing, skips existing, and records both", async () => {
        const created: string[] = [];
        const { tracker: t } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([STATES[0]]) },
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () => page([{ id: "l1", name: "bug" }]),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/modules/"),
                respond: () => page([{ id: "m1", name: "GUI" }]),
            },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "POST",
                respond: (u, _m, body) => {
                    const name = typeof body?.name === "string" ? body.name : "";
                    created.push(name);
                    return json({ id: "new", name });
                },
            },
        ]);
        const result = await t.ensureBoard("CG", template);
        expect(result.created.sort()).toEqual(
            ["label:tech-debt", "module:Website", "state:In Review", "type:Bug"].sort(),
        );
        expect(result.updated).toEqual([]);
        expect(result.skipped.sort()).toEqual(["label:bug", "module:GUI", "state:Todo"].sort());
        expect(result.warnings).toEqual([]);
        expect(created.sort()).toEqual(["Bug", "In Review", "Website", "tech-debt"].sort());
    });

    it("warns when createType fails (feature off) and does not throw", async () => {
        const { tracker: t } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () =>
                    page([
                        { id: "l1", name: "bug" },
                        { id: "l2", name: "tech-debt" },
                    ]),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/modules/"),
                respond: () =>
                    page([
                        { id: "m1", name: "GUI" },
                        { id: "m2", name: "Website" },
                    ]),
            },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "POST" && u.includes("/work-item-types/"),
                respond: () => new Response("feature disabled", { status: 400 }),
            },
            {
                match: (u, m) => m === "POST",
                respond: (_u, _m, body) => json({ id: "new", name: typeof body?.name === "string" ? body.name : "" }),
            },
        ]);
        const result = await t.ensureBoard("CG", template);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/Work Item Types/);
        expect(result.created).toEqual(["state:In Review"]);
    });

    it("reconciles drifted items: PATCHes color drift, skips matches, POSTs missing", async () => {
        const reconcileTemplate = {
            labels: [
                // color drift → PATCH
                { name: "blocked", color: "#EF4444" },
                // matches → skip
                { name: "bug", color: "#111" },
                // missing → POST
                { name: "new-label", color: "#222" },
            ],
            modules: [],
            states: [
                // color matches existing → skip
                { name: "Todo", color: "#aaa", group: "unstarted" as const },
                // color/sequence drift → PATCH
                { name: "In Progress", color: "#ABC123", group: "started" as const, sequence: 99 },
            ],
            types: [],
        };
        const { tracker: t, calls } = tracker([
            featuresRoute,
            {
                match: (u, m) => m === "GET" && u.includes("/states/"),
                respond: () =>
                    page([
                        { color: "#aaa", group: "unstarted", id: "s-todo", name: "Todo" },
                        { color: "#000", group: "started", id: "s-prog", name: "In Progress", sequence: 1 },
                    ]),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () =>
                    page([
                        { color: "#000000", id: "l-blocked", name: "blocked" },
                        { color: "#111", id: "l-bug", name: "bug" },
                    ]),
            },
            { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "PATCH" && u.includes("/states/s-prog/"),
                respond: () => json({ id: "s-prog" }),
            },
            {
                match: (u, m) => m === "PATCH" && u.includes("/labels/l-blocked/"),
                respond: () => json({ id: "l-blocked" }),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/labels/"),
                respond: (_u, _m, body) => json({ id: "l-new", name: typeof body?.name === "string" ? body.name : "" }),
            },
        ]);

        const result = await t.ensureBoard("CG", reconcileTemplate);

        expect(result.created).toEqual(["label:new-label"]);
        expect(result.updated.sort()).toEqual(["label:blocked", "state:In Progress"].sort());
        expect(result.skipped.sort()).toEqual(["label:bug", "state:Todo"].sort());
        expect(result.warnings).toEqual([]);

        const statePatch = calls.find((c) => c.method === "PATCH" && c.url.includes("/states/s-prog/"))!;
        expect(statePatch.body).toEqual({ color: "#ABC123", sequence: 99 });
        const labelPatch = calls.find((c) => c.method === "PATCH" && c.url.includes("/labels/l-blocked/"))!;
        expect(labelPatch.body).toEqual({ color: "#EF4444" });
    });

    it("flags an orphan module but does not delete it when prune is omitted", async () => {
        const orphanTemplate = {
            labels: [],
            modules: [{ name: "GUI" }],
            states: [],
            types: [],
        };
        const { tracker: t, calls } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([]) },
            {
                match: (u, m) => m === "GET" && u.includes("/modules/"),
                respond: () =>
                    page([
                        { id: "m-gui", name: "GUI" },
                        { id: "m-old", name: "OldModule" },
                    ]),
            },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
        ]);

        const result = await t.ensureBoard("CG", orphanTemplate);
        expect(result.orphans).toEqual(["module:OldModule"]);
        expect(result.pruned).toEqual([]);
        expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    });

    it("deletes an orphan module and records it as pruned when prune is true", async () => {
        const orphanTemplate = {
            labels: [],
            modules: [{ name: "GUI" }],
            states: [],
            types: [],
        };
        const { tracker: t, calls } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([]) },
            {
                match: (u, m) => m === "GET" && u.includes("/modules/"),
                respond: () =>
                    page([
                        { id: "m-gui", name: "GUI" },
                        { id: "m-old", name: "OldModule" },
                    ]),
            },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "DELETE" && u.includes("/modules/m-old/"),
                respond: () => new Response(null, { status: 204 }),
            },
        ]);

        const result = await t.ensureBoard("CG", orphanTemplate, { prune: true });
        expect(result.orphans).toEqual(["module:OldModule"]);
        expect(result.pruned).toEqual(["module:OldModule"]);
        const del = calls.find((c) => c.method === "DELETE")!;
        expect(del.url).toContain("/modules/m-old/");
    });

    it("prunes an orphan agent: label but leaves a non-agent label alone", async () => {
        const orphanTemplate = {
            labels: [{ name: "agent:claude" }],
            modules: [],
            states: [],
            types: [],
        };
        const { tracker: t, calls } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([]) },
            {
                match: (u, m) => m === "GET" && u.includes("/labels/"),
                respond: () =>
                    page([
                        { id: "l-claude", name: "agent:claude" },
                        { id: "l-old", name: "agent:old" },
                        { id: "l-mine", name: "my-manual-label" },
                    ]),
            },
            { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "DELETE" && u.includes("/labels/l-old/"),
                respond: () => new Response(null, { status: 204 }),
            },
        ]);

        const result = await t.ensureBoard("CG", orphanTemplate, { prune: true });
        // Only the orphan agent: label is flagged/pruned; the manual label is left alone.
        expect(result.orphans).toEqual(["label:agent:old"]);
        expect(result.pruned).toEqual(["label:agent:old"]);
        const deletes = calls.filter((c) => c.method === "DELETE");
        expect(deletes).toHaveLength(1);
        expect(deletes[0]!.url).toContain("/labels/l-old/");
    });

    it("records a warning when an update PATCH fails and continues", async () => {
        const driftTemplate = {
            labels: [],
            modules: [],
            states: [{ name: "Todo", color: "#new", group: "unstarted" as const }],
            types: [],
        };
        const { tracker: t } = tracker([
            featuresRoute,
            {
                match: (u, m) => m === "GET" && u.includes("/states/"),
                respond: () => page([{ color: "#old", group: "unstarted", id: "s-todo", name: "Todo" }]),
            },
            { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "PATCH" && u.includes("/states/s-todo/"),
                respond: () => new Response("boom", { status: 500 }),
            },
        ]);

        const result = await t.ensureBoard("CG", driftTemplate);
        expect(result.updated).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/update state:Todo failed/);
    });

    describe("module rename/remove/keep via resolveModuleChanges", () => {
        const orphanTemplate = {
            labels: [],
            modules: [{ name: "Unreal" }],
            states: [],
            types: [],
        };

        function moduleRoutes(existing: { id: string; name: string }[]): RouteHandler[] {
            return [
                featuresRoute,
                { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([]) },
                { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([]) },
                { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page(existing) },
                { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            ];
        }

        it("renames an orphan module when resolver returns rename decision", async () => {
            const { tracker: t, calls } = tracker([
                ...moduleRoutes([{ id: "m-internals", name: "Unreal Internals" }]),
                {
                    match: (u, m) => m === "PATCH" && u.includes("/modules/m-internals/"),
                    respond: () => json({ id: "m-internals", name: "Unreal" }),
                },
            ]);
            const result = await t.ensureBoard("CG", orphanTemplate, {
                resolveModuleChanges: async (_change) => ({
                    "Unreal Internals": { kind: "rename", to: "Unreal" },
                }),
            });
            const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/modules/m-internals/"));
            expect(patch).toBeDefined();
            expect(patch!.body).toEqual({ name: "Unreal" });
            expect(calls.some((c) => c.method === "POST")).toBe(false);
            expect(result.updated).toContain("module:Unreal Internals→Unreal");
            expect(result.pruned).toEqual([]);
            expect(result.orphans).toEqual([]);
        });

        it("removes an orphan module when resolver returns remove decision", async () => {
            const { tracker: t, calls } = tracker([
                ...moduleRoutes([{ id: "m-internals", name: "Unreal Internals" }]),
                {
                    match: (u, m) => m === "DELETE" && u.includes("/modules/m-internals/"),
                    respond: () => new Response(null, { status: 204 }),
                },
                {
                    match: (u, m) => m === "POST" && u.includes("/modules/"),
                    respond: () => json({ id: "m-new", name: "Unreal" }),
                },
            ]);
            const result = await t.ensureBoard("CG", orphanTemplate, {
                resolveModuleChanges: async (_change) => ({
                    "Unreal Internals": { kind: "remove" },
                }),
            });
            expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/modules/m-internals/"))).toBe(true);
            expect(result.pruned).toContain("module:Unreal Internals");
            expect(result.orphans).toEqual([]);
        });

        it("keeps an orphan module and records it as orphan when resolver returns keep decision (no prune)", async () => {
            const { tracker: t, calls } = tracker([
                ...moduleRoutes([{ id: "m-internals", name: "Unreal Internals" }]),
                {
                    match: (u, m) => m === "POST" && u.includes("/modules/"),
                    respond: () => json({ id: "m-new", name: "Unreal" }),
                },
            ]);
            const result = await t.ensureBoard("CG", orphanTemplate, {
                resolveModuleChanges: async (_change) => ({
                    "Unreal Internals": { kind: "keep" },
                }),
            });
            expect(calls.some((c) => c.method === "DELETE")).toBe(false);
            expect(result.orphans).toContain("module:Unreal Internals");
            expect(result.pruned).toEqual([]);
            expect(result.created).toContain("module:Unreal");
        });

        it("falls back to default orphan behavior (no resolver) when no resolveModuleChanges is provided", async () => {
            const { tracker: t, calls } = tracker([
                ...moduleRoutes([{ id: "m-internals", name: "Unreal Internals" }]),
                {
                    match: (u, m) => m === "POST" && u.includes("/modules/"),
                    respond: () => json({ id: "m-new", name: "Unreal" }),
                },
            ]);
            const result = await t.ensureBoard("CG", orphanTemplate);
            expect(calls.some((c) => c.method === "DELETE")).toBe(false);
            expect(result.orphans).toContain("module:Unreal Internals");
            expect(result.pruned).toEqual([]);
            expect(result.created).toContain("module:Unreal");
        });
    });

    it("PATCHes project features before any module or type POSTs", async () => {
        const freshTemplate = {
            labels: [],
            modules: [{ name: "Core" }],
            states: [],
            types: [{ name: "Bug" }],
        };
        const { tracker: t, calls } = tracker([
            featuresRoute,
            { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/labels/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([]) },
            { match: (u, m) => m === "GET" && u.includes("/work-item-types/"), respond: () => json([]) },
            {
                match: (u, m) => m === "POST" && u.includes("/modules/"),
                respond: (_u, _m, body) =>
                    json({ id: "m-core", name: typeof body?.name === "string" ? body.name : "" }),
            },
            {
                match: (u, m) => m === "POST" && u.includes("/work-item-types/"),
                respond: (_u, _m, body) =>
                    json({ id: "ty-bug", name: typeof body?.name === "string" ? body.name : "" }),
            },
        ]);

        await t.ensureBoard("CG", freshTemplate);

        const featuresPatchIdx = calls.findIndex((c) => c.method === "PATCH" && /\/projects\/[^/]+\/$/.test(c.url));
        const modulePostIdx = calls.findIndex((c) => c.method === "POST" && c.url.includes("/modules/"));
        const typePostIdx = calls.findIndex((c) => c.method === "POST" && c.url.includes("/work-item-types/"));

        expect(featuresPatchIdx).toBeGreaterThanOrEqual(0);
        expect(modulePostIdx).toBeGreaterThan(featuresPatchIdx);
        expect(typePostIdx).toBeGreaterThan(featuresPatchIdx);

        const featuresPatch = calls[featuresPatchIdx];
        expect(featuresPatch!.body).toEqual({
            is_issue_type_enabled: true,
            intake_view: true,
            module_view: true,
        });
    });
});

describe("PlaneTracker.blockedBy", () => {
    function subject(): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels: [],
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
        };
    }

    // A blocker work item fetched by UUID, with its state expanded so blockedBy
    // Can derive both the key (from sequence_id) and the done flag (from the group).
    function blocker(id: string, sequenceId: number, state: { group: string; name: string }): unknown {
        return {
            description_stripped: "",
            id,
            name: "Blocker",
            sequence_id: sequenceId,
            state: { color: "#fff", id: `s-${state.name}`, ...state },
        };
    }

    function relationsRoute(blockedBy: string[]): RouteHandler {
        return {
            match: (u, m) => m === "GET" && u.includes("/work-items/wi-42/relations/"),
            respond: () =>
                json({
                    blocked_by: blockedBy,
                    blocking: [],
                    duplicate: [],
                    finish_after: [],
                    finish_before: [],
                    relates_to: [],
                    start_after: [],
                    start_before: [],
                }),
        };
    }

    it("reports a blocker in a completed state as done", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            relationsRoute(["wi-5"]),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-5/"),
                respond: () => json(blocker("wi-5", 5, { group: "completed", name: "Done" })),
            },
        ]);
        const refs = await t.blockedBy(subject());
        expect(refs).toEqual([{ done: true, key: "CG-5" }]);
    });

    it("reports a blocker in a cancelled state as done", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            relationsRoute(["wi-5"]),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-5/"),
                respond: () => json(blocker("wi-5", 5, { group: "cancelled", name: "Cancelled" })),
            },
        ]);
        const refs = await t.blockedBy(subject());
        expect(refs).toEqual([{ done: true, key: "CG-5" }]);
    });

    it("reports a blocker in a started state as not done", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            relationsRoute(["wi-5"]),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-5/"),
                respond: () => json(blocker("wi-5", 5, { group: "started", name: "In Progress" })),
            },
        ]);
        const refs = await t.blockedBy(subject());
        expect(refs).toEqual([{ done: false, key: "CG-5" }]);
    });

    it("reports a blocker in an unstarted state as not done", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            relationsRoute(["wi-5"]),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-5/"),
                respond: () => json(blocker("wi-5", 5, { group: "unstarted", name: "Todo" })),
            },
        ]);
        const refs = await t.blockedBy(subject());
        expect(refs).toEqual([{ done: false, key: "CG-5" }]);
    });

    it("returns [] when the work item has no blocked_by relations", async () => {
        const { tracker: t } = tracker([...cacheRoutes, relationsRoute([])]);
        const refs = await t.blockedBy(subject());
        expect(refs).toEqual([]);
    });

    it("propagates a relations-fetch failure rather than reporting unblocked", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-42/relations/"),
                respond: () => new Response("boom", { status: 500 }),
            },
        ]);
        expect(t.blockedBy(subject())).rejects.toThrow(/failed with 500/);
    });
});

describe("PlaneTracker.issueContext", () => {
    function subject(over: Partial<Issue> = {}): Issue {
        return {
            areas: [],
            body: "",
            id: "wi-42",
            key: "CG-42",
            labels: [],
            meta: {},
            state: { group: "unstarted", name: "Todo" },
            title: "t",
            ...over,
        };
    }

    function attachmentsRoute(respond: RouteHandler["respond"]): RouteHandler {
        return {
            match: (u, m) => m === "GET" && u.includes("/work-items/wi-42/attachments/"),
            respond,
        };
    }

    it("maps attachments and the parent epic into the context", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            attachmentsRoute(() =>
                json([
                    { asset_url: "https://x/trace", attributes: { name: "trace.log" }, id: "a1" },
                    { asset_url: "https://x/spec", attributes: { name: "spec.pdf" }, id: "a2" },
                ]),
            ),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-epic/"),
                respond: () =>
                    json({
                        description_stripped: "Surrounding goal",
                        id: "wi-epic",
                        name: "Export epic",
                        sequence_id: 1,
                        state: { color: "#fff", group: "unstarted", id: "s-todo", name: "Todo" },
                        type: { id: "ty-epic", name: "Epic" },
                    }),
            },
        ]);
        const ctx = await t.issueContext(subject({ parentId: "wi-epic" }));
        expect(ctx.attachments).toEqual([
            { name: "trace.log", url: "https://x/trace" },
            { name: "spec.pdf", url: "https://x/spec" },
        ]);
        expect(ctx.parent).toEqual({ body: "Surrounding goal", key: "CG-1", title: "Export epic", type: "Epic" });
    });

    it("keeps named attachments (top-level or legacy name; URL optional), drops only nameless", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            attachmentsRoute(() =>
                json([
                    // Real Plane shape: top-level name + (often) no inline download URL.
                    { name: "top.png", id: "a1" },
                    // Legacy nested name + an inline URL.
                    { asset_url: "https://x/ok", attributes: { name: "good.log" }, id: "a2" },
                    // Nameless → dropped.
                    { asset_url: "https://x/noname", id: "a3" },
                ]),
            ),
        ]);
        const ctx = await t.issueContext(subject());
        expect(ctx.attachments).toEqual([
            { name: "top.png", url: "" },
            { name: "good.log", url: "https://x/ok" },
        ]);
    });

    it("fails closed to [] attachments when the attachments fetch throws", async () => {
        const { tracker: t } = tracker([...cacheRoutes, attachmentsRoute(() => new Response("nope", { status: 404 }))]);
        const ctx = await t.issueContext(subject());
        expect(ctx.attachments).toEqual([]);
        expect(ctx.parent).toBeUndefined();
    });

    it("omits the parent when the issue has no parentId", async () => {
        const { tracker: t } = tracker([...cacheRoutes, attachmentsRoute(() => json([]))]);
        const ctx = await t.issueContext(subject());
        expect(ctx.parent).toBeUndefined();
        expect(ctx.attachments).toEqual([]);
    });

    it("omits the parent (degrade-safe) when the parent fetch fails", async () => {
        const { tracker: t } = tracker([
            ...cacheRoutes,
            attachmentsRoute(() => json([])),
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-epic/"),
                respond: () => new Response("boom", { status: 500 }),
            },
        ]);
        const ctx = await t.issueContext(subject({ parentId: "wi-epic" }));
        expect(ctx.parent).toBeUndefined();
        expect(ctx.attachments).toEqual([]);
    });
});

describe("PlaneTracker.createIssue", () => {
    const labelRoutes: RouteHandler[] = [
        { match: (u, m) => m === "GET" && u.includes("/states/"), respond: () => page(STATES) },
        {
            match: (u, m) => m === "GET" && u.includes("/labels/"),
            respond: () =>
                page([
                    { id: "l-bug", name: "bug" },
                    { id: "l-blocked", name: "blocked" },
                ]),
        },
        { match: (u, m) => m === "GET" && u.includes("/modules/"), respond: () => page([{ id: "m1", name: "GUI" }]) },
        {
            match: (u, m) => m === "GET" && u.includes("/work-item-types/"),
            respond: () => json([{ id: "ty-bug", name: "Bug" }]),
        },
    ];

    // The POST response is intentionally unexpanded (state/labels as uuids, type_id
    // Only) so the test proves the adapter re-fetches the expanded item before mapping.
    function createRoutes(): RouteHandler[] {
        return [
            ...labelRoutes,
            {
                match: (u, m) => m === "POST" && u.endsWith("/work-items/"),
                respond: () =>
                    json({
                        description_html: "<p>body</p>",
                        id: "wi-new",
                        labels: ["l-bug"],
                        name: "New thing",
                        priority: "high",
                        sequence_id: 99,
                        state: "s-prog",
                        type_id: "ty-bug",
                    }),
            },
            {
                match: (u, m) => m === "GET" && u.includes("/work-items/wi-new/"),
                respond: () =>
                    json({
                        description_stripped: "body",
                        id: "wi-new",
                        labels: [{ id: "l-bug", name: "bug" }],
                        name: "New thing",
                        priority: "high",
                        sequence_id: 99,
                        state: { color: "#0f0", group: "started", id: "s-prog", name: "In Progress" },
                        type: { id: "ty-bug", name: "Bug" },
                    }),
            },
        ];
    }

    it("resolves names→ids, builds the POST body, and returns the re-fetched mapped Issue", async () => {
        const { tracker: t, calls } = tracker(createRoutes());
        const issue = await t.createIssue("CG", {
            assigneeId: "u-1",
            body: "<p>body</p>",
            labels: ["bug"],
            priority: "high",
            state: "In Progress",
            title: "New thing",
            type: "Bug",
        });

        const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/work-items/"))!;
        expect(post.body).toEqual({
            assignees: ["u-1"],
            description_html: "<p>body</p>",
            labels: ["l-bug"],
            name: "New thing",
            priority: "high",
            state: "s-prog",
            type_id: "ty-bug",
        });

        // Re-fetched expanded before mapping.
        expect(calls.some((c) => c.method === "GET" && c.url.includes("/work-items/wi-new/"))).toBe(true);
        expect(issue.key).toBe("CG-99");
        expect(issue.title).toBe("New thing");
        expect(issue.state.name).toBe("In Progress");
        expect(issue.labels).toEqual(["bug"]);
        expect(issue.type).toBe("Bug");
    });

    it("omits state when draft.state is absent (lets Plane assign its default)", async () => {
        const { tracker: t, calls } = tracker(createRoutes());
        await t.createIssue("CG", { body: "<p>body</p>", title: "New thing" });
        const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/work-items/"))!;
        expect(post.body).toEqual({ description_html: "<p>body</p>", name: "New thing" });
        expect(post.body).not.toHaveProperty("state");
    });

    it("throws on an unknown work-item type", async () => {
        const { tracker: t } = tracker(labelRoutes);
        expect(t.createIssue("CG", { body: "b", title: "x", type: "Nope" })).rejects.toThrow(
            /unknown work-item type "Nope"/,
        );
    });

    it("throws on an unknown label name", async () => {
        const { tracker: t } = tracker(labelRoutes);
        expect(t.createIssue("CG", { body: "b", labels: ["ghost"], title: "x" })).rejects.toThrow(
            /unknown label name "ghost"/,
        );
    });

    it("throws on an unknown state name", async () => {
        const { tracker: t } = tracker(labelRoutes);
        expect(t.createIssue("CG", { body: "b", state: "Ghost", title: "x" })).rejects.toThrow(
            /unknown state name "Ghost"/,
        );
    });
});

describe("PlaneTracker.activeCycleIssueIds", () => {
    // Always-active range so the cycle is current regardless of the real date.
    const ACTIVE_CYCLE = { end_date: "2999-12-31", id: "cy-1", name: "Sprint", start_date: "2000-01-01" };

    it("returns the work_item ids of the active cycle (falling back to id)", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/cy-1/cycle-issues/"),
                respond: () => page([{ work_item: "wi-1" }, { id: "wi-2" }, { id: "row-3", work_item: "wi-3" }]),
            },
            { match: (u, m) => m === "GET" && u.includes("/cycles/"), respond: () => page([ACTIVE_CYCLE]) },
        ]);
        const ids = await t.activeCycleIssueIds("CG");
        expect(ids).not.toBeNull();
        expect([...ids!].sort()).toEqual(["wi-1", "wi-2", "wi-3"]);
    });

    it("requests the cycle-issues membership endpoint (NOT cycle-work-items, which 404s)", async () => {
        // Regression: the membership path was `cycle-work-items/`, which Plane 404s
        // ("Page not found"). The verified path is `cycle-issues/`. Caught live (2026-06-18).
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/cy-1/cycle-issues/"),
                respond: () => page([{ id: "wi-1" }]),
            },
            { match: (u, m) => m === "GET" && u.includes("/cycles/"), respond: () => page([ACTIVE_CYCLE]) },
        ]);
        await t.activeCycleIssueIds("CG");
        const membershipCalls = calls.filter((c) => c.url.includes("/cycles/cy-1/"));
        expect(membershipCalls).toHaveLength(1);
        expect(membershipCalls[0]!.url).toContain("/cycle-issues/");
        expect(membershipCalls[0]!.url).not.toContain("/cycle-work-items/");
    });

    it("reads the work-item uuid from a cycle-issues row that has only an id (no work_item field)", async () => {
        // Regression: each cycle-issues result IS a full work item, so its `id` is the
        // work-item uuid; the adapter's `work_item ?? id` fallback must surface it. The
        // cycle dates come back as full ISO datetimes (e.g. 2026-06-16T00:00:01+03:00),
        // not bare YYYY-MM-DD — the active-cycle string comparison still handles them.
        const isoCycle = {
            end_date: "2026-07-02T23:59:00+03:00",
            id: "cy-iso",
            name: "Sprint",
            start_date: "2026-06-16T00:00:01+03:00",
        };
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/cy-iso/cycle-issues/"),
                respond: () => page([{ id: "wi-only-id", name: "A work item", description_html: "<p>x</p>" }]),
            },
            { match: (u, m) => m === "GET" && u.includes("/cycles/"), respond: () => page([isoCycle]) },
        ]);
        const ids = await t.activeCycleIssueIds("CG");
        expect(ids).not.toBeNull();
        expect([...ids!]).toEqual(["wi-only-id"]);
    });

    it("returns null when there is no active cycle (out-of-range dates)", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/"),
                respond: () => page([{ end_date: "1999-12-31", id: "cy-old", start_date: "1999-01-01" }]),
            },
        ]);
        expect(await t.activeCycleIssueIds("CG")).toBeNull();
    });

    it("returns null (degrade) when the cycles fetch fails", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/"),
                respond: () => new Response("nope", { status: 500 }),
            },
        ]);
        expect(await t.activeCycleIssueIds("CG")).toBeNull();
    });

    it("returns null (degrade) when the cycle-issues fetch fails", async () => {
        const { tracker: t } = tracker([
            {
                match: (u, m) => m === "GET" && u.includes("/cycles/cy-1/cycle-issues/"),
                respond: () => new Response("nope", { status: 500 }),
            },
            { match: (u, m) => m === "GET" && u.includes("/cycles/"), respond: () => page([ACTIVE_CYCLE]) },
        ]);
        expect(await t.activeCycleIssueIds("CG")).toBeNull();
    });
});

describe("PlaneTracker.createProject", () => {
    it("POSTs to workspaces/{slug}/projects/ and returns trackerProjectId from the response", async () => {
        const { tracker: t, calls } = tracker([
            {
                match: (u, m) => m === "POST" && u.endsWith("/projects/"),
                respond: () => json({ id: "proj-new" }),
            },
        ]);
        const result = await t.createProject({ identifier: "NP", name: "New Project" });
        const post = calls.find((c) => c.method === "POST")!;
        expect(post.url).toContain("/workspaces/your-workspace/projects/");
        expect(post.body).toEqual({ identifier: "NP", name: "New Project" });
        expect(result).toEqual({ trackerProjectId: "proj-new" });
    });
});

describe("verifyPlaneConfig", () => {
    it("throws an actionable error when the workspace is still the placeholder", () => {
        expect(() => {
            verifyPlaneConfig({ apiKeyEnv: "PLANE_API_KEY", workspaceSlug: "your-workspace" });
        }).toThrow(/placeholder "your-workspace".*PLANE_API_KEY/s);
    });

    it("accepts a real workspace slug", () => {
        expect(() => {
            verifyPlaneConfig({ apiKeyEnv: "PLANE_API_KEY", workspaceSlug: "acme" });
        }).not.toThrow();
    });
});

describe("PlaneTracker.findProjectId", () => {
    function projTracker(routes: RouteHandler[]) {
        const { fetch, calls } = router(routes);
        const client = new PlaneClient({ apiKey: "k", fetch, workspaceSlug: "acme" });
        return {
            calls,
            tracker: new PlaneTracker({
                auth: { apiKeyEnv: "PLANE_API_KEY", workspaceSlug: "acme" },
                client,
                registry,
            }),
        };
    }

    const projectsRoute = (projects: unknown[]): RouteHandler => ({
        match: (u, m) => m === "GET" && /\/workspaces\/acme\/projects\/(\?|$)/.test(u),
        respond: () => page(projects),
    });

    it("returns the project id when an existing identifier matches (case-insensitive)", async () => {
        const { tracker: t } = projTracker([
            projectsRoute([
                { id: "p-cg", identifier: "CG" },
                { id: "p-pp", identifier: "PP" },
            ]),
        ]);
        expect(await t.findProjectId("pp")).toBe("p-pp");
    });

    it("returns null when no project has that identifier", async () => {
        const { tracker: t } = projTracker([projectsRoute([{ id: "p-cg", identifier: "CG" }])]);
        expect(await t.findProjectId("ZZ")).toBeNull();
    });
});

describe("PlaneTracker.verifyAuth", () => {
    function authTracker(slug: string, routes: RouteHandler[]) {
        const { fetch, calls } = router(routes);
        const client = new PlaneClient({ apiKey: "k", fetch, workspaceSlug: slug });
        return {
            calls,
            tracker: new PlaneTracker({
                auth: { apiKeyEnv: "PLANE_API_KEY", workspaceSlug: slug },
                client,
                registry,
            }),
        };
    }

    it("short-circuits the placeholder workspace without any network call", async () => {
        const { tracker: t, calls } = authTracker("your-workspace", []);
        expect(t.verifyAuth()).rejects.toThrow(/placeholder "your-workspace"/);
        await Promise.resolve();
        expect(calls).toHaveLength(0);
    });

    it("resolves when the whoami endpoint returns 200", async () => {
        const { tracker: t, calls } = authTracker("acme", [
            { match: (u, m) => m === "GET" && u.includes("/users/me/"), respond: () => json({ id: "u-1" }) },
        ]);
        await t.verifyAuth();
        expect(calls.some((c) => c.url.includes("/users/me/"))).toBe(true);
    });

    it("maps a 401 to an actionable error naming the slug + env var", () => {
        const { tracker: t } = authTracker("acme", [
            { match: (u, m) => m === "GET" && u.includes("/users/me/"), respond: () => json({}, 401) },
        ]);
        expect(t.verifyAuth()).rejects.toThrow(/Plane token invalid for workspace "acme".*PLANE_API_KEY/s);
    });

    it("maps a 403 to an actionable error naming the slug + env var", () => {
        const { tracker: t } = authTracker("acme", [
            { match: (u, m) => m === "GET" && u.includes("/users/me/"), respond: () => json({}, 403) },
        ]);
        expect(t.verifyAuth()).rejects.toThrow(/Plane token invalid for workspace "acme".*PLANE_API_KEY/s);
    });
});

describe("createPlaneTracker", () => {
    const config: Config = {
        agents: {},
        agent: "claude",
        onManualMove: "yield",
        runMode: "supervised",
        tracker: "plane",
        trackers: {
            plane: {
                apiKeyEnv: "PLANE_API_KEY",
                baseUrl: "https://api.plane.so",
                workspaceSlug: "your-workspace",
            },
        },
    };

    it("reads the API key from env", () => {
        const t = createPlaneTracker(config, registry, { PLANE_API_KEY: "abc" });
        expect(t).toBeInstanceOf(PlaneTracker);
    });

    it("throws when the API key env var is unset", () => {
        expect(() => createPlaneTracker(config, registry, {})).toThrow(/PLANE_API_KEY.* is unset/);
    });
});
