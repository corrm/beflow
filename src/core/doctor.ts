import { resolveAcpxCommand } from "../agent/acpx.ts";
import type { Config, Registry } from "../config/schema.ts";

export type CheckLevel = "pass" | "warn" | "fail";

export interface DoctorCheck {
    name: string;
    level: CheckLevel;
    detail: string;
}

export interface DoctorDeps {
    loadConfig: () => Config;
    loadRegistry: () => Registry;
    env: NodeJS.ProcessEnv;
    fileExists: (path: string) => boolean;
    onPath: (cmd: string) => boolean;
    ping?: (config: Config, registry: Registry) => Promise<string>;
    boardChecks?: () => Promise<DoctorCheck[]>;
}

const API_KEY_HINT =
    "mint a personal API token (Plane: Profile → Settings → API tokens; Linear: Settings → API → Personal keys) and put it in .env as";

export async function doctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    let config: Config | undefined;
    try {
        config = deps.loadConfig();
        checks.push({
            detail: `loaded; active tracker "${config.tracker}"`,
            level: "pass",
            name: "config.json",
        });
    } catch (err) {
        checks.push({
            detail: err instanceof Error ? err.message : String(err),
            level: "fail",
            name: "config.json",
        });
    }

    const trackerConfig = config !== undefined ? config.trackers[config.tracker] : undefined;
    if (config !== undefined) {
        if (trackerConfig === undefined) {
            checks.push({
                detail: `no config for active tracker "${config.tracker}" under "trackers"`,
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
    } else {
        checks.push({
            detail: "skipped — config.json did not load",
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
                detail: "loaded but has no projects",
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
