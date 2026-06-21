import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

import { configDir, configPath } from "../config/paths.ts";
import { addProject } from "../config/persist.ts";
import type { Project, Registry } from "../config/schema.ts";
import type {
    EnsureBoardResult,
    ModuleChange,
    ModuleChangeAction,
    ProjectCreateSpec,
    ResolveModuleChanges,
    Tracker,
} from "../trackers/tracker.ts";
import type { Logger } from "./run.ts";
import type { RunStoreFs } from "./runstore.ts";
import { nodeRunStoreFs } from "./runstore.ts";
import { scaffoldAgentowners } from "./scaffold.ts";
import { beflowBoardTemplate } from "./template.ts";
import { expandHome } from "./worktree.ts";

// The interactive create boundary: given the missing key + active tracker, gather
// a project-create spec plus the config entry to write back. Injected so the
// orchestration core stays unit-testable without a TTY.
export type AskProjectSpec = (ctx: {
    key: string;
    tracker: string;
}) => Promise<{ spec: ProjectCreateSpec; entry: Project }>;

export interface SetupDeps {
    tracker: Tracker;
    trackerName: string;
    registry: Registry;
    agents: string[];
    prune?: boolean;
    log?: Logger;
    resolveModuleChanges?: ResolveModuleChanges;
    askProjectSpec?: AskProjectSpec;
    persist?: (dir: string, key: string, project: Project) => void;
    dir?: string;
    scaffoldFs?: RunStoreFs;
}

async function defaultResolveModuleChanges(change: ModuleChange): Promise<Record<string, ModuleChangeAction>> {
    const out: Record<string, ModuleChangeAction> = {};
    const available = [...change.added];
    for (const orphan of change.removed) {
        // Config is the source of truth: a module that is no longer in config was
        // Either renamed to one of the new modules or removed. "Keep" is not offered —
        // It would deliberately re-create the drift beflow exists to reconcile. Ctrl+C
        // Bails the whole reconcile (nothing changes).
        const options = [
            ...available.map((name) => ({
                hint: "keep the module and its issues",
                label: `Rename → ${name}`,
                value: `rename:${name}`,
            })),
            { hint: "delete; its issues become module-less", label: "Remove it", value: "remove" },
        ];
        const choice = await select({ message: `Module "${orphan}" is no longer in config — what is it?`, options });
        if (isCancel(choice)) {
            cancel(`beflow: module reconcile cancelled — nothing changed for "${orphan}"`);
            throw new Error("beflow: module reconcile cancelled");
        }
        if (typeof choice === "string" && choice.startsWith("rename:")) {
            const to = choice.slice("rename:".length);
            out[orphan] = { kind: "rename", to };
            const idx = available.indexOf(to);
            if (idx !== -1) {
                available.splice(idx, 1);
            }
        } else {
            out[orphan] = { kind: "remove" };
        }
    }
    return out;
}

// Shared cancel path for the create prompts: a Ctrl-C aborts cleanly so no
// project is created or written back. Like the defaults above, not unit-tested.
function cancelledCreate(): never {
    cancel("Cancelled.");
    throw new Error("beflow: project creation cancelled");
}

async function askText(message: string, opts?: { defaultValue?: string }): Promise<string> {
    const value = await text({
        message,
        validate: (v: string | undefined): string | undefined => ((v ?? "").trim() === "" ? "Required" : undefined),
        ...(opts?.defaultValue !== undefined
            ? { defaultValue: opts.defaultValue, placeholder: opts.defaultValue }
            : {}),
    });
    if (isCancel(value)) {
        cancelledCreate();
    }
    return value.trim();
}

async function askYes(message: string): Promise<boolean> {
    const value = await confirm({ message });
    if (isCancel(value)) {
        cancelledCreate();
    }
    return value;
}

// The clack-backed default asker: prompts for the project name + identifier, the
// repo map (default repo + extras), and optional module→repo entries, then
// returns the create spec plus the config entry (the orchestrator fills
// plane_project_id after the tracker create).
export async function defaultAskProjectSpec(ctx: {
    key: string;
    tracker: string;
}): Promise<{ spec: ProjectCreateSpec; entry: Project }> {
    const name = await askText("Project name");
    const identifier = await askText("Project identifier", { defaultValue: ctx.key });
    const root = await askText("Project root (absolute path)");

    const defaultRepoKey = await askText("Default repo key");
    const repos: Record<string, string> = {
        [defaultRepoKey]: await askText(`Absolute path for repo "${defaultRepoKey}"`),
    };
    while (await askYes("Add another repo?")) {
        const repoKey = await askText("Repo key");
        repos[repoKey] = await askText(`Absolute path for repo "${repoKey}"`);
    }

    const repoKeys = Object.keys(repos);
    const moduleRepoMap: Record<string, string> = {};
    while (await askYes("Add a module → repo mapping?")) {
        const moduleName = await askText("Module name");
        const repoKey = await text({
            message: `Repo key for module "${moduleName}"`,
            validate: (v: string | undefined): string | undefined => {
                const trimmed = (v ?? "").trim();
                if (trimmed === "") {
                    return "Required";
                }
                return repoKeys.includes(trimmed) ? undefined : `Unknown repo key — one of: ${repoKeys.join(", ")}`;
            },
        });
        if (isCancel(repoKey)) {
            cancelledCreate();
        }
        moduleRepoMap[moduleName] = repoKey.trim();
    }

    return {
        entry: {
            default_repo: defaultRepoKey,
            module_repo_map: moduleRepoMap,
            name,
            repos,
            root,
        },
        spec: { identifier, name },
    };
}

export async function setupProject(projectKey: string, deps: SetupDeps): Promise<EnsureBoardResult> {
    const log =
        deps.log ??
        ((): void => {
            /* no-op: logging disabled */
        });
    if (deps.registry.projects[projectKey] === undefined) {
        const ask = deps.askProjectSpec ?? (process.stdin.isTTY ? defaultAskProjectSpec : undefined);
        if (ask === undefined) {
            throw new Error(
                `beflow: project "${projectKey}" is not in ${configPath()}; run setup in an interactive terminal to create it`,
            );
        }
        const { entry, spec } = await ask({ key: projectKey, tracker: deps.trackerName });
        const { trackerProjectId } = await deps.tracker.createProject(spec);
        if (deps.trackerName === "plane" && trackerProjectId !== undefined) {
            entry.plane_project_id = trackerProjectId;
        }
        (deps.persist ?? addProject)(deps.dir ?? configDir(), projectKey, entry);
        // The tracker holds a reference to this same registry object; mutate it in
        // place so ensureBoard below sees the freshly created project.
        deps.registry.projects[projectKey] = entry;
        log(`beflow: created project ${projectKey} (${spec.identifier}) in ${deps.trackerName}`);
    }

    const template = beflowBoardTemplate(deps.registry, projectKey, deps.agents);
    const resolveModuleChanges =
        deps.resolveModuleChanges ?? (process.stdin.isTTY ? defaultResolveModuleChanges : undefined);
    const result = await deps.tracker.ensureBoard(projectKey, template, {
        prune: deps.prune,
        ...(resolveModuleChanges !== undefined ? { resolveModuleChanges } : {}),
    });

    log(
        `beflow: setup ${projectKey} — ${String(result.created.length)} created, ${String(result.updated.length)} updated, ${String(result.skipped.length)} skipped, ${String(result.pruned.length)} pruned`,
    );
    for (const warning of result.warnings) {
        log(`beflow: warning: ${warning}`);
    }

    if (deps.prune !== true && result.orphans.length > 0) {
        for (const orphan of result.orphans) {
            log(
                `beflow: orphan ${orphan} exists in Plane but not in config; run 'beflow update ${projectKey} --prune' to remove it`,
            );
        }
    }

    scaffoldControlPlane(deps.registry.projects[projectKey], deps.scaffoldFs ?? nodeRunStoreFs, log);

    return result;
}

// Drop the recommended control-plane AGENTOWNERS into every repo the project maps,
// skipping any repo that already has one. Activating the file is a separate, explicit
// Step (policy.evaluator = "agentowners"); setup only scaffolds, never mutates config.
function scaffoldControlPlane(project: Project | undefined, fs: RunStoreFs, log: Logger): void {
    if (project === undefined) {
        return;
    }
    let wroteAny = false;
    for (const repoPath of new Set(Object.values(project.repos))) {
        const { path, written } = scaffoldAgentowners(expandHome(repoPath), fs);
        if (written) {
            log(`beflow: wrote recommended control-plane AGENTOWNERS to ${path}`);
            wroteAny = true;
        } else {
            log(`beflow: AGENTOWNERS already present at ${path} — left untouched`);
        }
    }
    if (wroteAny) {
        log('beflow: to activate the gate, set policy.evaluator = "agentowners" in your beflow config');
    }
}
