import { isAbsolute, join } from "node:path";

import { resolveAcpxCommand } from "../agent/acpx.ts";
import type { Config, Registry } from "../config/schema.ts";
import { resolvePolicy } from "../resolve/precedence.ts";
import { DEFAULT_AGENTOWNERS_PATH } from "./scaffold.ts";
import { expandHome } from "./worktree.ts";

export type CheckLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
    name: string;
    level: CheckLevel;
    detail: string;
    fixable?: boolean;
}

export interface DoctorDeps {
    loadConfig: () => Config;
    loadRegistry: () => Registry;
    env: NodeJS.ProcessEnv;
    fileExists: (path: string) => boolean;
    onPath: (cmd: string) => boolean;
    verifyTrackerConfig?: (config: Config) => void;
    ping?: (config: Config, registry: Registry) => Promise<string>;
    boardChecks?: () => Promise<DoctorCheck[]>;
}

const API_KEY_HINT =
    "mint a personal API token (Plane: Profile → Settings → API tokens; Linear: Settings → API → Personal keys) and set it in your shell profile (e.g. ~/.zshrc) as";

export async function doctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    let config: Config | undefined;
    try {
        config = deps.loadConfig();
        checks.push({
            detail: `loaded; active tracker "${config.tracker}"`,
            level: "pass",
            name: "config",
        });
    } catch (err) {
        checks.push({
            detail: err instanceof Error ? err.message : String(err),
            fixable: true,
            level: "fail",
            name: "config",
        });
    }

    const trackerConfig = config !== undefined ? config.trackers[config.tracker] : undefined;
    if (config !== undefined) {
        if (trackerConfig === undefined) {
            checks.push({
                detail: `no config for active tracker "${config.tracker}" under "trackers"`,
                fixable: true,
                level: "fail",
                name: "tracker config",
            });
        } else {
            let issue: string | undefined;
            if (deps.verifyTrackerConfig !== undefined) {
                try {
                    deps.verifyTrackerConfig(config);
                } catch (err) {
                    issue = err instanceof Error ? err.message : String(err);
                }
            }
            if (issue !== undefined) {
                checks.push({
                    detail: issue,
                    level: "fail",
                    name: "tracker config",
                });
            } else {
                checks.push({
                    detail: `"${config.tracker}" configured`,
                    level: "pass",
                    name: "tracker config",
                });
            }
        }
    } else {
        checks.push({
            detail: "skipped — config did not load",
            level: "fail",
            name: "tracker config",
        });
    }

    let registry: Registry | undefined;
    try {
        registry = deps.loadRegistry();
        const count = Object.keys(registry.projects).length;
        if (count === 0) {
            checks.push({
                detail: "loaded but has no projects — run `beflow setup <KEY>` to register one",
                level: "fail",
                name: "projects",
            });
            registry = undefined;
        } else {
            checks.push({
                detail: `loaded; ${String(count)} project(s)`,
                level: "pass",
                name: "projects",
            });
        }
    } catch (err) {
        checks.push({
            detail: err instanceof Error ? err.message : String(err),
            level: "fail",
            name: "projects",
        });
    }

    let apiKeyOk = false;
    if (config !== undefined && trackerConfig !== undefined) {
        const envName = trackerConfig.apiKeyEnv;
        const value = deps.env[envName];
        if (value === undefined || value === "") {
            checks.push({
                detail: `${envName} is unset — ${API_KEY_HINT} ${envName}=…`,
                level: "fail",
                name: "API key",
            });
        } else {
            apiKeyOk = true;
            checks.push({
                detail: `${envName} is set`,
                level: "pass",
                name: "API key",
            });
        }
    } else {
        checks.push({
            detail: "skipped — config or tracker config did not load",
            level: "fail",
            name: "API key",
        });
    }

    if (registry !== undefined) {
        const missing: string[] = [];
        for (const [key, project] of Object.entries(registry.projects)) {
            if (!deps.fileExists(project.root)) {
                missing.push(`${key} root ${project.root}`);
            }
            for (const [repoName, repoPath] of Object.entries(project.repos)) {
                if (!deps.fileExists(repoPath)) {
                    missing.push(`${key} repo ${repoName} ${repoPath}`);
                }
            }
        }
        if (missing.length > 0) {
            checks.push({
                detail: `missing: ${missing.join("; ")}`,
                level: "fail",
                name: "repos on disk",
            });
        } else {
            checks.push({
                detail: "all project roots and repos exist",
                level: "pass",
                name: "repos on disk",
            });
        }
    } else {
        checks.push({
            detail: "skipped — registry did not load",
            level: "fail",
            name: "repos on disk",
        });
    }

    if (config !== undefined && registry !== undefined) {
        const parts: string[] = [];
        let anyMissing = false;
        for (const key of Object.keys(registry.projects)) {
            const policy = resolvePolicy(config, registry, key);
            if (policy.evaluator !== "agentowners") {
                parts.push(`${key}: ${policy.evaluator}`);
                continue;
            }
            const rel = policy.agentownersPath ?? DEFAULT_AGENTOWNERS_PATH;
            const repos = registry.projects[key]?.repos ?? {};
            const missingIn = Object.entries(repos)
                .filter(([, repoPath]) => {
                    const p = isAbsolute(rel) ? rel : join(expandHome(repoPath), rel);
                    return !deps.fileExists(p);
                })
                .map(([repoName]) => repoName);
            if (missingIn.length > 0) {
                anyMissing = true;
                parts.push(
                    `${key}: agentowners — file MISSING in ${missingIn.join(", ")} (runs require approval until created)`,
                );
            } else {
                parts.push(`${key}: agentowners → ${rel}`);
            }
        }
        checks.push({
            detail: parts.length > 0 ? parts.join("; ") : "no projects",
            level: anyMissing ? "warn" : "pass",
            name: "policy",
        });
    }

    const acpxCmd = config !== undefined ? resolveAcpxCommand(config) : ["bunx", "acpx"];
    const launcher = acpxCmd[0];
    if (launcher === undefined) {
        throw new Error("beflow: acpx command resolved to an empty array");
    }
    if (deps.onPath(launcher)) {
        checks.push({
            detail: `found on PATH (${acpxCmd.join(" ")})`,
            level: "pass",
            name: "acpx",
        });
    } else {
        checks.push({
            detail: `launcher "${launcher}" not on PATH — default is "bunx acpx" (ships with bun); or set tools.acpx, or run: bun add -g acpx`,
            level: "fail",
            name: "acpx",
        });
    }

    if (deps.onPath("gh")) {
        checks.push({ detail: "found on PATH", level: "pass", name: "gh" });
    } else {
        checks.push({
            detail: "not on PATH — only needed for the PR step of implement mode",
            level: "warn",
            name: "gh",
        });
    }

    if (deps.ping !== undefined) {
        if (config === undefined || trackerConfig === undefined || registry === undefined || !apiKeyOk) {
            checks.push({
                detail: "skipped — an earlier check failed",
                level: "fail",
                name: "live ping",
            });
        } else {
            try {
                const detail = await deps.ping(config, registry);
                checks.push({ detail, level: "pass", name: "live ping" });
            } catch (err) {
                checks.push({
                    detail: err instanceof Error ? err.message : String(err),
                    level: "fail",
                    name: "live ping",
                });
            }
        }
    }

    if (deps.boardChecks !== undefined) {
        if (config === undefined || trackerConfig === undefined || registry === undefined || !apiKeyOk) {
            checks.push({
                detail: "skipped — an earlier check failed",
                level: "fail",
                name: "board drift",
            });
        } else {
            try {
                checks.push(...(await deps.boardChecks()));
            } catch (err) {
                checks.push({
                    detail: err instanceof Error ? err.message : String(err),
                    level: "fail",
                    name: "board drift",
                });
            }
        }
    }

    return checks;
}

export interface FixAction {
    name: string;
    done: boolean;
    detail: string;
}

export interface DoctorFixDeps {
    configPath: () => string;
    readConfig: (path: string) => string | null;
    writeConfig: (path: string, content: string) => void;
    ensureDir: (path: string) => void;
    dirExists: (path: string) => boolean;
    resolveDirs: () => { worktrees: string; runs: string; decisions: string };
    bootstrap: string;
    activeTrackerBlock: (tracker: string) => Record<string, unknown> | undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        return null;
    }
    return isJsonObject(parsed) ? parsed : null;
}

export function fixDoctor(deps: DoctorFixDeps): FixAction[] {
    const actions: FixAction[] = [];

    const path = deps.configPath();
    const existing = deps.readConfig(path);
    if (existing === null) {
        deps.writeConfig(path, deps.bootstrap);
        actions.push({ detail: `created ${path} from the built-in template`, done: true, name: "config file" });
    } else {
        actions.push({ detail: `already present (${path})`, done: false, name: "config file" });
    }

    const current = deps.readConfig(path);
    if (current === null) {
        actions.push({
            detail: "skipped — config file is unreadable",
            done: false,
            name: "tracker block",
        });
    } else {
        const config = parseJsonObject(current);
        if (config === null) {
            actions.push({
                detail: `cannot auto-repair: ${path} is not valid JSON — fix it by hand`,
                done: false,
                name: "tracker block",
            });
        } else {
            const tracker = typeof config.tracker === "string" ? config.tracker : undefined;
            if (tracker === undefined) {
                actions.push({
                    detail: "skipped — no active tracker set in config",
                    done: false,
                    name: "tracker block",
                });
            } else {
                const trackers = isJsonObject(config.trackers) ? config.trackers : {};
                if (Object.prototype.hasOwnProperty.call(trackers, tracker)) {
                    actions.push({
                        detail: `already present (trackers.${tracker})`,
                        done: false,
                        name: "tracker block",
                    });
                } else {
                    const block = deps.activeTrackerBlock(tracker);
                    if (block === undefined) {
                        actions.push({
                            detail: `skipped — no template block for tracker "${tracker}"`,
                            done: false,
                            name: "tracker block",
                        });
                    } else {
                        const next = { ...config, trackers: { ...trackers, [tracker]: block } };
                        deps.writeConfig(path, JSON.stringify(next, null, 2) + "\n");
                        actions.push({
                            detail: `added trackers.${tracker}`,
                            done: true,
                            name: "tracker block",
                        });
                    }
                }
            }
        }
    }

    const dirs = deps.resolveDirs();
    for (const [name, dir] of [
        ["worktrees dir", dirs.worktrees],
        ["runs dir", dirs.runs],
        ["decisions dir", dirs.decisions],
    ] as const) {
        if (deps.dirExists(dir)) {
            actions.push({ detail: `already present (${dir})`, done: false, name });
        } else {
            deps.ensureDir(dir);
            actions.push({ detail: `created ${dir}`, done: true, name });
        }
    }

    return actions;
}
