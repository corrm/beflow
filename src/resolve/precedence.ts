import type { Config, Project, Registry } from "../config/schema.ts";
import type { IssueMeta, JobKind, ResolvedPolicy, ResolvedPr, Resolved, RunMode, StateGroup } from "../model/types.ts";
import { autoDetectJobKind } from "./jobkind.ts";

export interface ResolveInputs {
    cli: Partial<Resolved>;
    meta: IssueMeta;
    project: Project;
    // Optional because the resolver is defensive: if nothing global is set it
    // falls through to the built-in. (In practice config always fills these.)
    global: {
        agent?: string;
        routing?: { implement?: string; spec?: string; triage?: string };
        runMode?: RunMode;
    };
    issue: {
        type?: string;
        state: { group: StateGroup };
        areas: string[];
    };
}

export function cascade<T>(...candidates: (T | undefined)[]): T | undefined {
    for (const candidate of candidates) {
        if (candidate !== undefined) {
            return candidate;
        }
    }
    return undefined;
}

const AGENT_BUILTIN = "claude";
const RUN_MODE_BUILTIN: RunMode = "supervised";

export function resolveAgent(inputs: ResolveInputs, jobKind: JobKind): string {
    return (
        cascade(
            inputs.cli.agent,
            inputs.meta.agent,
            inputs.project.routing?.[jobKind],
            inputs.global.routing?.[jobKind],
            inputs.project.agent,
            inputs.global.agent,
        ) ?? AGENT_BUILTIN
    );
}

export function resolveRunMode(inputs: ResolveInputs): RunMode {
    return (
        cascade(inputs.cli.runMode, inputs.meta.runMode, inputs.project.runMode, inputs.global.runMode) ??
        RUN_MODE_BUILTIN
    );
}

function areaDerivedRepo(areas: string[], project: Project): string | undefined {
    const primary = areas[0];
    if (primary === undefined) {
        return undefined;
    }
    return project.module_repo_map[primary];
}

export function resolveRepo(inputs: ResolveInputs): {
    repo: string;
    repoPath: string;
} {
    const repo = cascade(
        inputs.cli.repo,
        inputs.meta.repo,
        areaDerivedRepo(inputs.issue.areas, inputs.project),
        inputs.project.default_repo,
    );

    if (repo === undefined) {
        throw new Error("beflow: could not resolve a repo for this issue");
    }

    const repoPath = inputs.project.repos[repo];
    if (repoPath === undefined) {
        const known = Object.keys(inputs.project.repos).join(", ");
        throw new Error(`beflow: resolved repo "${repo}" is not present in project.repos (known: ${known})`);
    }

    return { repo, repoPath };
}

export function resolveJobKind(inputs: ResolveInputs): JobKind {
    return (
        cascade(inputs.cli.jobKind, inputs.meta.jobKind) ??
        autoDetectJobKind(inputs.issue.type, inputs.issue.state.group)
    );
}

const PR_OWNER_BUILTIN: ResolvedPr["owner"] = "agent";
const PR_BASE_BRANCH_BUILTIN = "auto";
const POLICY_EVALUATOR_BUILTIN: ResolvedPolicy["evaluator"] = "off";
const POLICY_ON_BLOCK_BUILTIN: ResolvedPolicy["onBlock"] = "comment";

/**
 * Project-over-default resolution of PR mechanics. A present `projects.<KEY>.pr`
 * replaces the top-level `pr` wholesale (no field merge); the built-in defaults
 * (`agent` / `auto`) then fill any field the chosen block leaves unset.
 */
export function resolvePr(config: Config, registry: Registry, projectKey: string): ResolvedPr {
    const block = registry.projects[projectKey]?.pr ?? config.pr;
    return {
        owner: block?.owner ?? PR_OWNER_BUILTIN,
        baseBranch: block?.baseBranch ?? PR_BASE_BRANCH_BUILTIN,
    };
}

/**
 * Project-over-default resolution of the post-run policy gate. A present
 * `projects.<KEY>.policy` replaces the top-level `policy` wholesale (no field
 * merge); the built-in defaults (evaluator `off`, onBlock `comment`) then fill
 * any field the chosen block leaves unset.
 */
export function resolvePolicy(config: Config, registry: Registry, projectKey: string): ResolvedPolicy {
    const block = registry.projects[projectKey]?.policy ?? config.policy;
    return {
        evaluator: block?.evaluator ?? POLICY_EVALUATOR_BUILTIN,
        command: block?.command,
        rules: block?.rules,
        agentownersPath: block?.agentownersPath,
        onBlock: block?.onBlock ?? POLICY_ON_BLOCK_BUILTIN,
    };
}

export function resolve(inputs: ResolveInputs): Resolved {
    const { repo, repoPath } = resolveRepo(inputs);
    const jobKind = resolveJobKind(inputs);
    return {
        agent: resolveAgent(inputs, jobKind),
        jobKind,
        repo,
        repoPath,
        runMode: resolveRunMode(inputs),
    };
}
