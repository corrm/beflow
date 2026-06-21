import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { xdgConfigHome } from "../config/xdg.ts";

// ACP McpServer shapes beflow forwards to acpx via `.acpxrc.json`. The stdio
// Variant is the untagged union member: it carries NO `type` field. http/sse
// Are tagged and carry a URL plus optional name/value header pairs.
export interface McpStdioServer {
    name: string;
    command: string;
    args: string[];
    env: { name: string; value: string }[];
}

export interface McpHttpServer {
    type: "http";
    name: string;
    url: string;
    headers?: { name: string; value: string }[];
}

export interface McpSseServer {
    type: "sse";
    name: string;
    url: string;
    headers?: { name: string; value: string }[];
}

export type McpServer = McpHttpServer | McpSseServer | McpStdioServer;

// The user-authored `.mcp.json` map (oh-my-pi / Claude format): a record of
// Name → entry. `type` defaults to stdio; stdio needs `command`, http/sse need
// `url`. superRefine enforces those per-variant requirements.
const mcpEntrySchema = z
    .object({
        args: z.array(z.string()).optional(),
        command: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        type: z.enum(["http", "sse", "stdio"]).optional(),
        url: z.string().optional(),
    })
    .superRefine((entry, ctx) => {
        const type = entry.type ?? "stdio";
        if (type === "stdio") {
            if (entry.command === undefined) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "stdio MCP server requires `command`" });
            }
        } else if (entry.url === undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${type} MCP server requires \`url\`` });
        }
    });

export type McpEntry = z.infer<typeof mcpEntrySchema>;

export const mcpFileSchema = z.object({
    mcpServers: z.record(z.string(), mcpEntrySchema),
});

export interface McpResolveDeps {
    configDir: string;
    exists: (p: string) => boolean;
    read: (p: string) => string;
}

export function defaultMcpDeps(configDir: string): McpResolveDeps {
    return {
        configDir,
        exists: existsSync,
        read: (p) => readFileSync(p, "utf8"),
    };
}

function toHeaderPairs(headers: Record<string, string>): { name: string; value: string }[] {
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

// Translate a validated `.mcp.json` entry into the ACP McpServer shape.
function translate(name: string, entry: McpEntry): McpServer {
    const type = entry.type ?? "stdio";
    if (type === "http" || type === "sse") {
        const url = entry.url ?? "";
        return {
            name,
            type,
            url,
            ...(entry.headers !== undefined ? { headers: toHeaderPairs(entry.headers) } : {}),
        };
    }
    return {
        args: entry.args ?? [],
        command: entry.command ?? "",
        env: Object.entries(entry.env ?? {}).map(([envName, value]) => ({ name: envName, value })),
        name,
    };
}

function loadMap(path: string, deps: McpResolveDeps): Record<string, McpEntry> {
    if (!deps.exists(path)) {
        return {};
    }
    const parsed: unknown = JSON.parse(deps.read(path));
    return mcpFileSchema.parse(parsed).mcpServers;
}

// Load + merge the `.mcp.json` cascade and translate it to ACP McpServer shapes.
// Cascade (project wins per server NAME): GLOBAL `$XDG_CONFIG_HOME/beflow/.mcp.json`,
// Then PROJECT `<configDir>/.mcp.json`. Missing files are skipped. Returns `[]`
// When nothing is configured.
export function loadMcpServers(deps: McpResolveDeps): McpServer[] {
    const globalPath = join(xdgConfigHome(), ".mcp.json");
    const projectPath = join(deps.configDir, ".mcp.json");
    const merged: Record<string, McpEntry> = {
        ...loadMap(globalPath, deps),
        ...loadMap(projectPath, deps),
    };
    return Object.entries(merged).map(([name, entry]) => translate(name, entry));
}

export interface McpFs {
    exists(p: string): boolean;
    read(p: string): string;
    write(p: string, data: string): void;
    remove(p: string): void;
}

export const nodeMcpFs: McpFs = {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, "utf8"),
    remove: (p) => {
        rmSync(p, { force: true });
    },
    write: (p, data) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, data, "utf8");
    },
};

// Write a managed `.acpxrc.json` at `<cwd>/.acpxrc.json` setting `mcpServers`,
// Preserving any other keys from a pre-existing file, and return a CLEANUP that
// Restores the exact prior content (or removes the file when there was none).
// Empty `servers` is a no-op returning a no-op cleanup. Cleanup never throws.
export function injectAcpxMcp(cwd: string, servers: McpServer[], fs: McpFs): () => void {
    if (servers.length === 0) {
        return (): void => {
            /* no-op: nothing was injected */
        };
    }

    const path = join(cwd, ".acpxrc.json");
    const prior: string | null = fs.exists(path) ? fs.read(path) : null;

    const base: Record<string, unknown> = {};
    if (prior !== null) {
        try {
            const parsed: unknown = JSON.parse(prior);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                for (const [k, v] of Object.entries(parsed)) {
                    base[k] = v;
                }
            }
        } catch {
            // Unparseable prior: start from {} for the merge, but the exact prior
            // String is still captured above for an exact restore on cleanup.
        }
    }

    base.mcpServers = servers;
    fs.write(path, `${JSON.stringify(base, null, 2)}\n`);

    return (): void => {
        try {
            if (prior === null) {
                fs.remove(path);
            } else {
                fs.write(path, prior);
            }
        } catch {
            // Best-effort restore, mirroring the worktree-removal pattern: a failure
            // To restore must never mask the run's own outcome.
        }
    };
}
