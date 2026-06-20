export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export type RunMode = "autonomous" | "supervised";

export type JobKind = "triage" | "spec" | "implement";

export interface IssueMeta {
    agent?: string;
    repo?: string;
    runMode?: RunMode;
    jobKind?: JobKind;
}

export interface Issue {
    id: string;
    key: string;
    title: string;
    body: string;
    type?: string;
    state: { name: string; group: StateGroup };
    labels: string[];
    areas: string[];
    priority?: string;
    parentId?: string;
    meta: IssueMeta;
    archived?: boolean;
}

export interface Resolved {
    agent: string;
    jobKind: JobKind;
    repo: string;
    repoPath: string;
    runMode: RunMode;
}

export type PrOwner = "beflow" | "agent";

export interface ResolvedPr {
    owner: PrOwner;
    baseBranch: string;
}

export type PolicyEvaluator = "globs" | "command" | "agentowners" | "off";

export type PolicyDecision = "block" | "require_approval" | "allow";

export type PolicyOnBlock = "comment";

export interface PolicyRule {
    paths?: string[];
    agent?: string;
    decision: PolicyDecision;
}

export interface ResolvedPolicy {
    evaluator: PolicyEvaluator;
    command?: string[];
    rules?: PolicyRule[];
    agentownersPath?: string;
    onBlock: PolicyOnBlock;
}
