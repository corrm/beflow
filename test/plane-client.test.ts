import { describe, expect, it } from "bun:test";

import { PlaneClient } from "../src/trackers/plane/client.ts";
import type { FetchLike } from "../src/trackers/plane/client.ts";

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
}

function headersToObject(init?: RequestInit): Record<string, string> {
    const out: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === "object" && !Array.isArray(h)) {
        for (const [k, v] of Object.entries(h)) {
            out[k] = String(v);
        }
    }
    return out;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
        status,
    });
}

function recorder(handler: (call: Call) => Response): {
    fetch: FetchLike;
    calls: Call[];
} {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
        const bodyText = typeof init?.body === "string" ? init.body : null;
        const parsedBody: unknown = bodyText !== null ? (JSON.parse(bodyText) as unknown) : undefined;
        const call: Call = {
            body: parsedBody,
            headers: headersToObject(init),
            method: init?.method ?? "GET",
            url,
        };
        calls.push(call);
        return handler(call);
    };
    return { calls, fetch };
}

function client(fetch: FetchLike, extra: Partial<{ sleep: (ms: number) => Promise<void> }> = {}) {
    return new PlaneClient({
        apiKey: "secret-key",
        fetch,
        workspaceSlug: "your-workspace",
        ...extra,
    });
}

describe("PlaneClient request basics", () => {
    it("sends auth + content-type + accept headers", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ id: "x" }));
        await client(fetch).getWorkItemByIdentifier("CG-42");
        expect(calls[0]!.headers["X-API-Key"]).toBe("secret-key");
        expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
        expect(calls[0]!.headers.Accept).toBe("application/json");
    });

    it("builds the by-identifier URL with expand", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ id: "x" }));
        await client(fetch).getWorkItemByIdentifier("CG-42");
        expect(calls[0]!.url).toBe(
            "https://api.plane.so/api/v1/workspaces/your-workspace/work-items/CG-42/?expand=state,labels",
        );
        expect(calls[0]!.method).toBe("GET");
    });

    it("patchWorkItem PATCHes the right URL with body", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ id: "wi" }));
        await client(fetch).patchWorkItem("pid", "wi", { state: "su" });
        expect(calls[0]!.method).toBe("PATCH");
        expect(calls[0]!.url).toBe("https://api.plane.so/api/v1/workspaces/your-workspace/projects/pid/work-items/wi/");
        expect(calls[0]!.body).toEqual({ state: "su" });
    });

    it("createComment POSTs comment_html", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ id: "c" }));
        await client(fetch).createComment("pid", "wi", { comment_html: "<p>hi</p>" });
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url).toBe(
            "https://api.plane.so/api/v1/workspaces/your-workspace/projects/pid/work-items/wi/comments/",
        );
        expect(calls[0]!.body).toEqual({ comment_html: "<p>hi</p>" });
    });

    it("createLink POSTs url + title", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ id: "lk" }));
        await client(fetch).createLink("pid", "wi", { title: "PR", url: "http://x" });
        expect(calls[0]!.url).toBe(
            "https://api.plane.so/api/v1/workspaces/your-workspace/projects/pid/work-items/wi/links/",
        );
        expect(calls[0]!.body).toEqual({ title: "PR", url: "http://x" });
    });

    it("listTypes reads a BARE ARRAY (work-item-types is not cursor-paginated)", async () => {
        // Regression: GET /work-item-types/ returns a bare array, unlike states/
        // Labels/modules which return a {results} envelope. Routing it through
        // Paginate() spread `undefined` and threw — caught live against real Plane.
        const types = [
            { id: "t1", name: "Bug" },
            { id: "t2", name: "Spike" },
        ];
        const { fetch, calls } = recorder(() => jsonResponse(types));
        const result = await client(fetch).listTypes("pid");
        expect(result).toEqual(types);
        expect(calls[0]!.method).toBe("GET");
        expect(calls[0]!.url).toBe(
            "https://api.plane.so/api/v1/workspaces/your-workspace/projects/pid/work-item-types/",
        );
    });

    it("updateIntakeStatus PATCHes intake-issues/<issueId>/status/", async () => {
        // Regression: the old patchIntake hit intake-issues/<id>/ (no /status/ suffix,
        // wrong id) — Plane rejects that with HTTP 400. Verified live 2026-06-18.
        const { fetch, calls } = recorder(() => jsonResponse({ id: "issue-1" }));
        await client(fetch).updateIntakeStatus("pid", "issue-1", 1);
        expect(calls[0]!.url).toBe(
            "https://api.plane.so/api/v1/workspaces/your-workspace/projects/pid/intake-issues/issue-1/status/",
        );
        expect(calls[0]!.body).toEqual({ status: 1 });
    });

    it("listCycleWorkItems hits the cycle-issues membership endpoint (NOT cycle-work-items)", async () => {
        // Regression: the path was `cycle-work-items/`, which Plane 404s ("Page not
        // found"). The verified membership path is `cycle-issues/` — caught live (2026-06-18).
        const { fetch, calls } = recorder(() => jsonResponse({ next_page_results: false, results: [{ id: "wi-1" }] }));
        const items = await client(fetch).listCycleWorkItems("pid", "cy-1");
        expect(items).toEqual([{ id: "wi-1" }]);
        expect(calls[0]!.method).toBe("GET");
        expect(calls[0]!.url).toContain("/cycles/cy-1/cycle-issues/");
        expect(calls[0]!.url).not.toContain("cycle-work-items");
    });
});

describe("PlaneClient pagination", () => {
    it("concatenates results across two pages via next_cursor", async () => {
        const { fetch, calls } = recorder((call) => {
            if (call.url.includes("cursor=")) {
                return jsonResponse({
                    next_cursor: "",
                    next_page_results: false,
                    results: [{ id: "b" }],
                });
            }
            return jsonResponse({
                next_cursor: "100:1:0",
                next_page_results: true,
                results: [{ id: "a" }],
            });
        });
        const items = await client(fetch).listWorkItems("pid");
        expect(items.map((i) => i.id)).toEqual(["a", "b"]);
        expect(calls).toHaveLength(2);
        expect(calls[0]!.url).toContain("per_page=100");
        expect(calls[1]!.url).toContain("cursor=100%3A1%3A0");
    });

    it("listWorkItems URL includes expand and order_by", async () => {
        const { fetch, calls } = recorder(() => jsonResponse({ next_page_results: false, results: [] }));
        await client(fetch).listWorkItems("pid", { order_by: "-priority" });
        expect(calls[0]!.url).toContain("expand=state%2Clabels");
        expect(calls[0]!.url).toContain("order_by=-priority");
    });
});

describe("PlaneClient retries and errors", () => {
    it("retries on 429 honoring Retry-After then succeeds", async () => {
        const slept: number[] = [];
        let n = 0;
        const fetch: FetchLike = async () => {
            n += 1;
            if (n === 1) {
                return new Response("rate limited", {
                    headers: { "Retry-After": "2" },
                    status: 429,
                });
            }
            return jsonResponse({ id: "ok" });
        };
        const c = client(fetch, {
            sleep: async (ms) => {
                slept.push(ms);
            },
        });
        const result = await c.getWorkItemByIdentifier("CG-1");
        expect(result.id).toBe("ok");
        expect(slept).toEqual([2000]);
        expect(n).toBe(2);
    });

    it("gives up after 2 retries and throws", async () => {
        let n = 0;
        const fetch: FetchLike = async () => {
            n += 1;
            return new Response("rate limited", {
                headers: { "Retry-After": "1" },
                status: 429,
            });
        };
        const c = client(fetch, { sleep: async () => {} });
        expect(c.getWorkItemByIdentifier("CG-1")).rejects.toThrow(/429/);
        expect(n).toBe(3); // Initial + 2 retries
    });

    it("throws an informative message on non-2xx", async () => {
        const fetch: FetchLike = async () => new Response("not found here", { status: 404 });
        expect(client(fetch).getWorkItemByIdentifier("CG-9")).rejects.toThrow(
            /GET .*work-items\/CG-9.* failed with 404: not found here/,
        );
    });

    it("tolerates a 204 empty body", async () => {
        const fetch: FetchLike = async () => new Response(null, { status: 204 });
        const result = await client(fetch).patchWorkItem("pid", "wi", {});
        expect(result).toBeUndefined();
    });

    it("tolerates an empty 200 body", async () => {
        const fetch: FetchLike = async () => new Response("", { status: 200 });
        const result = await client(fetch).createComment("pid", "wi", {
            comment_html: "<p>x</p>",
        });
        expect(result).toBeUndefined();
    });
});
