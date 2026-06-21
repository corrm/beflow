import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { xdgConfigHome } from "../src/config/xdg.ts";
import { defaultMcpDeps, injectAcpxMcp, loadMcpServers, mcpFileSchema } from "../src/core/mcp.ts";
import type { McpFs, McpResolveDeps, McpServer } from "../src/core/mcp.ts";

function fakeResolveDeps(files: Record<string, string>): McpResolveDeps {
    return {
        configDir: "/cfg",
        exists: (p) => p in files,
        read: (p) => {
            const v = files[p];
            if (v === undefined) {
                throw new Error(`missing ${p}`);
            }
            return v;
        },
    };
}

function memMcpFs(): { fs: McpFs; store: Map<string, string> } {
    const store = new Map<string, string>();
    const fs: McpFs = {
        exists: (p) => store.has(p),
        read: (p) => {
            const v = store.get(p);
            if (v === undefined) {
                throw new Error(`missing ${p}`);
            }
            return v;
        },
        remove: (p) => {
            store.delete(p);
        },
        write: (p, data) => {
            store.set(p, data);
        },
    };
    return { fs, store };
}

describe("mcpFileSchema validation", () => {
    it("accepts a stdio entry with a command", () => {
        const result = mcpFileSchema.safeParse({
            mcpServers: { codegraph: { args: ["serve"], command: "bunx" } },
        });
        expect(result.success).toBe(true);
    });

    it("rejects a stdio entry missing command", () => {
        const result = mcpFileSchema.safeParse({
            mcpServers: { broken: { type: "stdio" } },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an http entry missing url", () => {
        const result = mcpFileSchema.safeParse({
            mcpServers: { web: { type: "http" } },
        });
        expect(result.success).toBe(false);
    });

    it("rejects an sse entry missing url", () => {
        const result = mcpFileSchema.safeParse({
            mcpServers: { stream: { type: "sse" } },
        });
        expect(result.success).toBe(false);
    });

    it("accepts an http entry with a url", () => {
        const result = mcpFileSchema.safeParse({
            mcpServers: { web: { type: "http", url: "https://example/mcp" } },
        });
        expect(result.success).toBe(true);
    });
});

describe("loadMcpServers cascade", () => {
    it("returns [] when no .mcp.json files exist", () => {
        expect(loadMcpServers(fakeResolveDeps({}))).toEqual([]);
    });

    it("loads a project-only .mcp.json", () => {
        const deps = fakeResolveDeps({
            "/cfg/.mcp.json": JSON.stringify({
                mcpServers: { codegraph: { args: ["serve"], command: "bunx" } },
            }),
        });
        expect(loadMcpServers(deps)).toEqual([{ args: ["serve"], command: "bunx", env: [], name: "codegraph" }]);
    });

    it("merges global + project, with project overriding global by name", () => {
        const prior = process.env.XDG_CONFIG_HOME;
        process.env.XDG_CONFIG_HOME = "/xdg-config";
        try {
            const deps = fakeResolveDeps({
                "/cfg/.mcp.json": JSON.stringify({
                    mcpServers: { shared: { command: "project-cmd" } },
                }),
                [join(xdgConfigHome(), ".mcp.json")]: JSON.stringify({
                    mcpServers: { onlyGlobal: { command: "g" }, shared: { command: "global-cmd" } },
                }),
            });
            const servers = loadMcpServers(deps);
            const byName = new Map(servers.map((s) => [s.name, s]));
            expect(byName.size).toBe(2);
            // Project wins for the shared name.
            expect(byName.get("shared")).toEqual({ args: [], command: "project-cmd", env: [], name: "shared" });
            expect(byName.get("onlyGlobal")).toEqual({ args: [], command: "g", env: [], name: "onlyGlobal" });
        } finally {
            if (prior === undefined) {
                delete process.env.XDG_CONFIG_HOME;
            } else {
                process.env.XDG_CONFIG_HOME = prior;
            }
        }
    });
});

describe("translation to ACP shape", () => {
    it("stdio → {name,command,args,env:[{name,value}]} with NO type", () => {
        const deps = fakeResolveDeps({
            "/cfg/.mcp.json": JSON.stringify({
                mcpServers: {
                    codegraph: {
                        args: ["codegraph", "serve", "--mcp"],
                        command: "bunx",
                        env: { TOKEN: "abc" },
                        type: "stdio",
                    },
                },
            }),
        });
        const [server] = loadMcpServers(deps);
        expect(server).toEqual({
            args: ["codegraph", "serve", "--mcp"],
            command: "bunx",
            env: [{ name: "TOKEN", value: "abc" }],
            name: "codegraph",
        });
        expect(server !== undefined && "type" in server).toBe(false);
    });

    it("http → {type:'http',name,url} with translated headers", () => {
        const deps = fakeResolveDeps({
            "/cfg/.mcp.json": JSON.stringify({
                mcpServers: {
                    web: { headers: { Authorization: "Bearer x" }, type: "http", url: "https://example/mcp" },
                },
            }),
        });
        const [server] = loadMcpServers(deps);
        expect(server).toEqual({
            headers: [{ name: "Authorization", value: "Bearer x" }],
            name: "web",
            type: "http",
            url: "https://example/mcp",
        });
    });

    it("http without headers omits the headers key", () => {
        const deps = fakeResolveDeps({
            "/cfg/.mcp.json": JSON.stringify({
                mcpServers: { web: { type: "http", url: "https://example/mcp" } },
            }),
        });
        const [server] = loadMcpServers(deps);
        expect(server).toEqual({ name: "web", type: "http", url: "https://example/mcp" });
    });

    it("sse → {type:'sse',name,url}", () => {
        const deps = fakeResolveDeps({
            "/cfg/.mcp.json": JSON.stringify({
                mcpServers: { stream: { type: "sse", url: "https://example/sse" } },
            }),
        });
        const [server] = loadMcpServers(deps);
        expect(server).toEqual({ name: "stream", type: "sse", url: "https://example/sse" });
    });
});

describe("injectAcpxMcp", () => {
    const servers: McpServer[] = [{ args: [], command: "bunx", env: [], name: "codegraph" }];

    it("writes .acpxrc.json with mcpServers when none existed, and cleanup removes it", () => {
        const { fs, store } = memMcpFs();
        const cleanup = injectAcpxMcp("/wt", servers, fs);

        const written = store.get("/wt/.acpxrc.json");
        expect(written).toBeDefined();
        expect(JSON.parse(written ?? "")).toEqual({ mcpServers: servers });

        cleanup();
        expect(store.has("/wt/.acpxrc.json")).toBe(false);
    });

    it("merges into an existing file preserving other keys", () => {
        const { fs, store } = memMcpFs();
        store.set("/wt/.acpxrc.json", JSON.stringify({ approveReads: true, model: "opus" }));
        injectAcpxMcp("/wt", servers, fs);

        const parsed: unknown = JSON.parse(store.get("/wt/.acpxrc.json") ?? "");
        expect(parsed).toEqual({ approveReads: true, mcpServers: servers, model: "opus" });
    });

    it("cleanup restores the EXACT prior content", () => {
        const { fs, store } = memMcpFs();
        const prior = JSON.stringify({ approveReads: true, model: "opus" });
        store.set("/wt/.acpxrc.json", prior);
        const cleanup = injectAcpxMcp("/wt", servers, fs);

        // The injected file differs from the prior while the run is live.
        expect(store.get("/wt/.acpxrc.json")).not.toBe(prior);

        cleanup();
        expect(store.get("/wt/.acpxrc.json")).toBe(prior);
    });

    it("treats an unparseable prior as {} for the merge but restores it exactly", () => {
        const { fs, store } = memMcpFs();
        store.set("/wt/.acpxrc.json", "{ not json");
        const cleanup = injectAcpxMcp("/wt", servers, fs);

        expect(JSON.parse(store.get("/wt/.acpxrc.json") ?? "")).toEqual({ mcpServers: servers });

        cleanup();
        expect(store.get("/wt/.acpxrc.json")).toBe("{ not json");
    });

    it("empty servers is a no-op returning a no-op cleanup", () => {
        const { fs, store } = memMcpFs();
        const cleanup = injectAcpxMcp("/wt", [], fs);
        expect(store.size).toBe(0);
        // Cleanup must not touch the (absent) file.
        cleanup();
        expect(store.size).toBe(0);
    });
});

describe("defaultMcpDeps", () => {
    it("carries the configDir", () => {
        const deps = defaultMcpDeps("/some/dir");
        expect(deps.configDir).toBe("/some/dir");
    });
});
