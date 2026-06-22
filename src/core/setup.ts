import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

import { configDir, configPath } from "../config/paths.ts";
import { addProject, upsertProject } from "../config/persist.ts";
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
// a project-create spec plus the config entry to write back. `findProjectId` lets
// the asker detect — right after the identifier question — that the tracker already
// has a project with that identifier, so it can offer to link instead of wasting
// the rest of the questionnaire on a create that would 409. When the asker links,
// it returns the resolved tracker project id in `linkedProjectId` and the
// orchestrator skips createProject. Injected so the core stays unit-testable.
export type AskProjectSpec = (ctx: {
    key: string;
    tracker: string;
    findProjectId: (identifier: string) => Promise<string | null>;
}) => Promise<{ spec: ProjectCreateSpec; entry: Project; linkedProjectId?: string }>;

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
    // Opt-in: present ONLY when the agentowners gate is selected
    // (policy.evaluator = "agentowners"). `path` is the configured agentownersPath —
    // the exact location the evaluator reads — so the starter file lands where the
    // gate looks. Absent → beflow never drops files into the repo.
    scaffoldOwners?: { path: string };
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

// @clack runs `validate` on the raw typed value (empty on a bare Enter) BEFORE it
// substitutes `defaultValue`. So "Required" must apply only when there is no default;
// with a default, an empty submission means "take the default" and is valid.
export function requiredText(value: string | undefined, hasDefault: boolean): string | undefined {
    if ((value ?? "").trim() === "" && !hasDefault) {
        return "Required";
    }
    return undefined;
}

async function askText(message: string, opts?: { defaultValue?: string }): Promise<string> {
    const defaultValue = opts?.defaultValue;
    const value = await text({
        message,
        validate: (v: string | undefined): string | undefined => requiredText(v, defaultValue !== undefined),
        ...(defaultValue !== undefined ? { defaultValue, placeholder: defaultValue } : {}),
    });
    if (isCancel(value)) {
        cancelledCreate();
    }
    const trimmed = value.trim();
    if (trimmed === "" && defaultValue !== undefined) {
        return defaultValue;
    }
    return trimmed;
}

async function askYes(message: string): Promise<boolean> {
    const value = await confirm({ message });
    if (isCancel(value)) {
        cancelledCreate();
    }
    return value;
}

// The clack-backed default asker: prompts for the project name + identifier, checks
// the tracker for an identifier collision before going further, then gathers the
// repo map (default repo + extras) and — only when more than one repo exists —
// optional module→repo entries. Returns the create spec plus the config entry (the
// orchestrator fills plane_project_id after create or from the link).
export async function defaultAskProjectSpec(ctx: {
    key: string;
    tracker: string;
    findProjectId: (identifier: string) => Promise<string | null>;
}): Promise<{ spec: ProjectCreateSpec; entry: Project; linkedProjectId?: string }> {
    const name = await askText("Project name");

    let identifier = await askText("Project identifier", { defaultValue: ctx.key });
    let linkedProjectId: string | undefined;
    for (;;) {
        const existing = await ctx.findProjectId(identifier);
        if (existing === null) {
            break;
        }
        const link = await askYes(
            `A project with identifier "${identifier}" already exists in ${ctx.tracker}. Link beflow to it? (No = pick a different identifier)`,
        );
        if (link) {
            linkedProjectId = existing;
            break;
        }
        identifier = await askText("Project identifier", { defaultValue: ctx.key });
    }

    const root = await askText("Project root (absolute path)");

    const defaultRepoKey = await askText("Default repo key", { defaultValue: "main" });
    const repos: Record<string, string> = {
        [defaultRepoKey]: await askText(`Absolute path for repo "${defaultRepoKey}"`, { defaultValue: root }),
    };
    while (await askYes("Add another repo?")) {
        const repoKey = await askText("Repo key");
        repos[repoKey] = await askText(`Absolute path for repo "${repoKey}"`);
    }

    const repoKeys = Object.keys(repos);
    const moduleRepoMap: Record<string, string> = {};
    // A module→repo mapping only disambiguates between repos; with a single repo
    // every module maps to it implicitly, so don't ask.
    if (repoKeys.length > 1) {
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
        ...(linkedProjectId !== undefined ? { linkedProjectId } : {}),
    };
}

function noopLog(): void {
    /* logging disabled */
}

// Reconcile the project's board to the beflow template: states, labels, modules,
// types. Shared by setup (after create/link) and update. Also scaffolds the
// recommended control-plane AGENTOWNERS into each mapped repo.
async function reconcileBoard(projectKey: string, deps: SetupDeps, log: Logger): Promise<EnsureBoardResult> {
    const template = beflowBoardTemplate(deps.registry, projectKey, deps.agents);
    const resolveModuleChanges =
        deps.resolveModuleChanges ?? (process.stdin.isTTY ? defaultResolveModuleChanges : undefined);
    const result = await deps.tracker.ensureBoard(projectKey, template, {
        prune: deps.prune,
        ...(resolveModuleChanges !== undefined ? { resolveModuleChanges } : {}),
    });

    log(
        `beflow: ${projectKey} — ${String(result.created.length)} created, ${String(result.updated.length)} updated, ${String(result.skipped.length)} skipped, ${String(result.pruned.length)} pruned`,
    );
    for (const warning of result.warnings) {
        log(`beflow: warning: ${warning}`);
    }

    if (deps.prune !== true && result.orphans.length > 0) {
        for (const orphan of result.orphans) {
            log(
                `beflow: orphan ${orphan} exists in ${deps.trackerName} but not in config; run 'beflow update ${projectKey} --prune' to remove it`,
            );
        }
    }

    if (deps.scaffoldOwners !== undefined) {
        scaffoldControlPlane(
            deps.registry.projects[projectKey],
            deps.scaffoldOwners.path,
            deps.scaffoldFs ?? nodeRunStoreFs,
            log,
        );
    }

    return result;
}

export async function setupProject(projectKey: string, deps: SetupDeps): Promise<EnsureBoardResult> {
    const log = deps.log ?? noopLog;
    await deps.tracker.verifyAuth();

    if (deps.registry.projects[projectKey] === undefined) {
        const ask = deps.askProjectSpec ?? (process.stdin.isTTY ? defaultAskProjectSpec : undefined);
        if (ask === undefined) {
            throw new Error(
                `beflow: project "${projectKey}" is not in ${configPath()}; run setup in an interactive terminal to create it`,
            );
        }
        const { entry, spec, linkedProjectId } = await ask({
            findProjectId: async (identifier) => deps.tracker.findProjectId(identifier),
            key: projectKey,
            tracker: deps.trackerName,
        });

        let trackerProjectId = linkedProjectId;
        if (trackerProjectId === undefined) {
            ({ trackerProjectId } = await deps.tracker.createProject(spec));
            log(`beflow: created project ${projectKey} (${spec.identifier}) in ${deps.trackerName}`);
        } else {
            log(
                `beflow: linked project ${projectKey} (${spec.identifier}) to the existing ${deps.trackerName} project`,
            );
        }

        if (deps.trackerName === "plane" && trackerProjectId !== undefined) {
            entry.plane_project_id = trackerProjectId;
        }
        (deps.persist ?? addProject)(deps.dir ?? configDir(), projectKey, entry);
        // The tracker holds a reference to this same registry object; mutate it in
        // place so reconcileBoard below sees the freshly created project.
        deps.registry.projects[projectKey] = entry;
    }

    return reconcileBoard(projectKey, deps, log);
}

// update never creates: it reconciles an existing config project's board to the
// template. When the entry has no tracker link yet (a hand-added config entry),
// resolve it by identifier and persist the link, but fail clearly rather than
// create anything.
export async function updateProject(projectKey: string, deps: SetupDeps): Promise<EnsureBoardResult> {
    const log = deps.log ?? noopLog;

    // Config membership needs no network, so reject an unknown key instantly
    // before authenticating.
    const entry = deps.registry.projects[projectKey];
    if (entry === undefined) {
        throw new Error(
            `beflow: project "${projectKey}" is not in ${configPath()} — run \`beflow setup ${projectKey}\` to create or adopt it`,
        );
    }

    await deps.tracker.verifyAuth();

    if (deps.trackerName === "plane" && entry.plane_project_id === undefined) {
        const found = await deps.tracker.findProjectId(projectKey);
        if (found === null) {
            throw new Error(
                `beflow: project "${projectKey}" has no plane_project_id and no ${deps.trackerName} project with identifier "${projectKey}" exists — run \`beflow setup ${projectKey}\``,
            );
        }
        entry.plane_project_id = found;
        (deps.persist ?? upsertProject)(deps.dir ?? configDir(), projectKey, entry);
        log(`beflow: linked project ${projectKey} to the existing ${deps.trackerName} project`);
    }

    return reconcileBoard(projectKey, deps, log);
}

// Drop the starter AGENTOWNERS into every repo the project maps, skipping any repo
// that already has one. Only reached when the agentowners gate is selected
// (policy.evaluator = "agentowners"), so the gate has the file it reads.
function scaffoldControlPlane(project: Project | undefined, ownersPath: string, fs: RunStoreFs, log: Logger): void {
    if (project === undefined) {
        return;
    }
    for (const repoPath of new Set(Object.values(project.repos))) {
        const { path, written } = scaffoldAgentowners(expandHome(repoPath), ownersPath, fs);
        if (written) {
            log(`beflow: agentowners gate is on — wrote starter AGENTOWNERS to ${path}`);
        } else {
            log(`beflow: AGENTOWNERS already present at ${path} — left untouched`);
        }
    }
}
