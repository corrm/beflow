import type { Project } from "../config/schema.ts";
import type { IssueMeta, JobKind, Resolved, RunMode, StateGroup } from "../model/types.ts";
import { autoDetectJobKind } from "./jobkind.ts";

export interface ResolveInputs {
    cli: Partial<Resolved>;
    meta: IssueMeta;
    project: Project;
    // Optional because the resolver is defensive: if nothing global is set it
    // falls through to the built-in. (In practice config.defaults always fills these.)
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
            inputs.project.defaults?.agent,
            inputs.global.agent,
        ) ?? AGENT_BUILTIN
    );
}

export function resolveRunMode(inputs: ResolveInputs): RunMode {
    return (
        cascade(inputs.cli.runMode, inputs.meta.runMode, inputs.project.defaults?.runMode, inputs.global.runMode) ??
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
