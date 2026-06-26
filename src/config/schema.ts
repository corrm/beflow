import { z } from "zod";

export const runModeSchema = z.enum(["autonomous", "supervised"]);
export const jobKindSchema = z.enum(["triage", "spec", "implement"]);

export const routingSchema = z
    .object({
        implement: z.string().optional(),
        spec: z.string().optional(),
        triage: z.string().optional(),
    })
    .optional();

export const prOwnerSchema = z.enum(["beflow", "agent"]);

export const prSchema = z
    .object({
        owner: prOwnerSchema.optional(),
        baseBranch: z.string().optional(),
    })
    .optional();

export const advisorSeveritySchema = z.enum(["aside", "concern", "blocker"]);

export const advisorSchema = z
    .object({
        enabled: z.boolean().default(false),
        agents: z.array(z.string()).optional(),
        maxNudges: z.number().int().min(0).optional(),
    })
    .optional();

export type AdvisorConfig = z.infer<typeof advisorSchema>;
export type AdvisorSeverity = z.infer<typeof advisorSeveritySchema>;

export const policyEvaluatorSchema = z.enum(["globs", "command", "agentowners", "off"]);
export const policyDecisionSchema = z.enum(["block", "require_approval", "allow"]);
export const policyOnBlockSchema = z.enum(["comment"]);

export const policyRuleSchema = z.object({
    paths: z.array(z.string()).optional(),
    agent: z.string().optional(),
    decision: policyDecisionSchema,
});

export const policySchema = z
    .object({
        evaluator: policyEvaluatorSchema.optional(),
        command: z.array(z.string()).optional(),
        rules: z.array(policyRuleSchema).optional(),
        agentownersPath: z.string().optional(),
        onBlock: policyOnBlockSchema.optional(),
    })
    .optional();

export type PrConfig = z.infer<typeof prSchema>;
export type PrOwner = z.infer<typeof prOwnerSchema>;
export type PolicyConfig = z.infer<typeof policySchema>;
export type PolicyEvaluator = z.infer<typeof policyEvaluatorSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type PolicyOnBlock = z.infer<typeof policyOnBlockSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const projectSchema = z.object({
    default_repo: z.string(),
    agent: z.string().optional(),
    runMode: runModeSchema.optional(),
    ci: z.object({ autoReworkOnRed: z.boolean().optional() }).optional(),
    deadLetter: z.object({ maxAttempts: z.number().optional() }).optional(),
    inputQuality: z.object({ minBodyChars: z.number().optional() }).optional(),
    limits: z
        .object({
            inReview: z.number().optional(),
            inProgress: z.number().optional(),
            maxRunMinutes: z.number().optional(),
        })
        .optional(),
    module_repo_map: z.record(z.string(), z.string()),
    name: z.string(),
    plane_project_id: z.string().optional(),
    policy: policySchema,
    pr: prSchema,
    qualityGate: z
        .object({
            commands: z.array(z.string()).optional(),
            maxRework: z.number().int().min(0).optional(),
            baselineTestGlobs: z.array(z.string()).optional(),
        })
        .optional(),
    repos: z.record(z.string(), z.string()),
    review: z.object({ enabled: z.boolean().optional(), postToPr: z.boolean().optional() }).optional(),
    root: z.string(),
    routing: routingSchema,
    scheduling: z.object({ activeCycleOnly: z.boolean().optional() }).optional(),
    sla: z.object({ inReviewMinutes: z.number().optional(), needsInputMinutes: z.number().optional() }).optional(),
    telemetry: z.object({ inComment: z.boolean().optional() }).optional(),
});

export type Project = z.infer<typeof projectSchema>;

export const agentConfigSchema = z.object({
    // Interactive CLI binary used by the `--open` direct spawn. REQUIRED.
    command: z.string(),
    // Extra args appended to the `--open` direct spawn (before the task).
    args: z.array(z.string()).optional(),
    // ACP-server binary used by acpx `--auto`/`--attend`; defaults to `command`.
    acpCommand: z.string().optional(),
    // Args for the ACP server; beflow passes acpx
    // `--agent "<acpCommand ?? command> <acpArgs...>"` for --auto/--attend.
    acpArgs: z.array(z.string()).optional(),
    // Acpx `--model` for `--auto`/`--attend`.
    model: z.string().optional(),
    permissionPolicy: z.unknown().optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agentsMapSchema = z.record(z.string(), agentConfigSchema);

export const workspaceSchema = z.object({
    id: z.string(),
    slug: z.string(),
});

// The single on-disk shape of config.json: tracker settings + registry
// (workspace + projects) + the per-agent map, all in one file.
export const fileSchema = z.object({
    $schema: z.string().optional(),
    _comment: z.string().optional(),
    tracker: z.enum(["plane", "linear"]),
    trackers: z.object({
        linear: z
            .object({
                apiKeyEnv: z.string(),
            })
            .optional(),
        plane: z
            .object({
                baseUrl: z.string(),
                workspaceSlug: z.string(),
                apiKeyEnv: z.string(),
            })
            .optional(),
    }),
    agent: z.string(),
    runMode: runModeSchema,
    // Optional tracker user id; when set, beflow assigns the issue to this user
    // As it picks it up (moves it to In Progress), for both --auto and --attend.
    assignee: z.string().optional(),
    // Unified dead-letter cap: how many accumulated failed attempts (across crash
    // Resume + CI rework) before beflow quarantines the item to Needs Input.
    // Per-project `projects.<KEY>.deadLetter` overrides this global; default 3.
    deadLetter: z.object({ maxAttempts: z.number().optional() }).optional(),
    // Opt-in input-quality gate. When `minBodyChars` > 0, a fresh autonomous
    // Dispatch of a too-thin issue is parked to Needs Input instead of burning an
    // Agent run. Per-project `projects.<KEY>.inputQuality` overrides this global.
    inputQuality: z.object({ minBodyChars: z.number().optional() }).optional(),
    // Inline parent-epic + attachment context into the agent task. Default on; set false to disable.
    linkedContext: z.boolean().optional(),
    // How beflow reacts when a human moves a card out of beflow's hands (out of
    // The started group) while a run is live. `yield` lets the run finish but
    // Skips writeback so the human's move stands; `abort` additionally cancels
    // The agent mid-run. Always present after parse thanks to the default.
    onManualMove: z.enum(["yield", "abort"]).default("yield"),
    // PR mechanics. `owner` decides whether beflow or the agent opens the PR
    // (default `agent`, the current back-compat behavior); `baseBranch` is the
    // Target branch (`auto` ⇒ detect the repo default branch at runtime).
    // Per-project `projects.<KEY>.pr` overrides this global.
    pr: prSchema,
    // Opt-in quality gate: project check command(s) run in the worktree before an
    // Implement `done` report opens a PR / advances to In Review. On RED beflow
    // Auto-reworks the live agent session up to `maxRework` times (default 1; 0
    // Disables auto-rework), re-checking after each; still-red is failed.
    // Per-project `projects.<KEY>.qualityGate` overrides this global.
    qualityGate: z
        .object({
            commands: z.array(z.string()).optional(),
            maxRework: z.number().int().min(0).optional(),
            baselineTestGlobs: z.array(z.string()).optional(),
        })
        .optional(),
    // Opt-in PR review assist. When `enabled`, watch dispatches a reviewer agent over
    // In-Review items and posts its findings as an issue comment; `postToPr` also posts
    // Them on the PR. Per-project `projects.<KEY>.review` overrides this global.
    review: z.object({ enabled: z.boolean().optional(), postToPr: z.boolean().optional() }).optional(),
    // Opt-in agent routing by jobkind. Keys are jobkind names; values are agent names
    // From config.agents. Per-project `projects.<KEY>.routing` overrides this global.
    routing: routingSchema,
    // Opt-in SLA aging: minutes an item may sit in Needs Input / In Review before
    // Beflow re-pings the escalation channel. Per-project `projects.<KEY>.sla`
    // Overrides this global.
    sla: z.object({ inReviewMinutes: z.number().optional(), needsInputMinutes: z.number().optional() }).optional(),
    // Opt-in run telemetry: when `inComment`, beflow appends a compact token/cost
    // Line to its writeback comment on the issue. Default off. Per-project
    // `projects.<KEY>.telemetry` overrides this global.
    telemetry: z.object({ inComment: z.boolean().optional() }).optional(),
    // Where `--auto` runs create their per-issue git worktrees. `~` expands to the
    // Home dir; defaults to $XDG_DATA_HOME/beflow/worktrees (fallback
    // ~/.local/share/beflow/worktrees, outside any repo).
    worktrees: z
        .object({
            dir: z.string(),
        })
        .optional(),
    // When enabled, beflow reads a user `.mcp.json` cascade and injects the
    // Translated servers as a managed `.acpxrc.json` into the agent cwd for
    // Acpx-driven runs (`--auto`/`watch`/`--attend`). Disabled by default.
    mcp: z.object({ enabled: z.boolean().default(false) }).optional(),
    // Opt-in advisor (the "deputy"): after each agent turn in `--auto`, a second
    // Model reviews the committed work against the contract and either logs an
    // Aside, re-dispatches with a correction (concern), or escalates to Needs Input
    // (blocker, or a concern that survives `maxNudges`). `agents` names config.agents
    // Entries (v1 uses the first); off by default.
    advisor: advisorSchema,
    // Where `--auto` runs persist their per-issue run-records so an interrupted
    // Run can resume. `~` expands to home; defaults to $XDG_STATE_HOME/beflow/runs
    // (fallback ~/.local/state/beflow/runs).
    runs: z.object({ dir: z.string() }).optional(),
    // Append-only canonical decision log: every post-run policy decision is
    // Written here as one NDJSON event, outliving the run-record GC. `~` expands
    // To home; defaults to $XDG_STATE_HOME/beflow/decisions (fallback
    // ~/.local/state/beflow/decisions, a sibling of the runs dir).
    // `comment` (default true) posts a human-readable receipt of each decision
    // As a comment on the tracker issue; set false to opt out.
    decisions: z.object({ dir: z.string().optional(), comment: z.boolean().optional() }).optional(),
    // External tool launchers. `acpx` is the command array beflow spawns to run
    // Acpx (command + leading args); defaults to `["bunx", "acpx"]` (bun-first).
    tools: z.object({ acpx: z.array(z.string()).optional() }).optional(),
    // Directory of user-editable prompt templates that override the compiled-in
    // Defaults. `~` expands to home; each `<name>.md` overrides that prompt.
    prompts: z.object({ dir: z.string() }).optional(),
    // Opt-in post-run policy gate. `evaluator` selects how a finished run's diff is
    // Judged before its PR is accepted: `globs` matches changed paths against `rules`,
    // `command` shells out to an external argv, `off` disables the gate (default).
    // `onBlock` is how a block surfaces (only `comment` for now). Per-project
    // `projects.<KEY>.policy` overrides this global wholesale.
    policy: policySchema,
    workspace: workspaceSchema,
    projects: z.record(z.string(), projectSchema),
    agents: agentsMapSchema.optional(),
});

export type ConfigFile = z.infer<typeof fileSchema>;

// The Config slice consumed by tracker/run/doctor code. `agents` is always
// Present (loaders default it to {}), so downstream may read config.agents
// Without an undefined guard.
export const configSchema = fileSchema
    .omit({
        _comment: true,
        projects: true,
        workspace: true,
    })
    .extend({ agents: agentsMapSchema });

export type Config = z.infer<typeof configSchema>;

// The Registry slice: workspace + projects.
export const registrySchema = z.object({
    projects: z.record(z.string(), projectSchema),
    workspace: workspaceSchema,
});

export type Registry = z.infer<typeof registrySchema>;
