#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineCommand, runCommand, showUsage } from "citty";
import type { ArgsDef, CommandContext, CommandDef } from "citty";

import { AcpxDriver, resolveAcpCommand, resolveAcpxCommand } from "./agent/acpx.ts";
import type { AgentDriver } from "./agent/driver.ts";
import { loadConfig, loadRegistry } from "./config/load.ts";
import { configDir } from "./config/paths.ts";
import type { Config, Registry } from "./config/schema.ts";
import { ConfigStore, nodeConfigWatcher } from "./config/store.ts";
import type { ConfigWatcher } from "./config/store.ts";
import { acceptIntake } from "./core/accept.ts";
import { isDecisionHeld } from "./core/decision.ts";
import { doctor } from "./core/doctor.ts";
import type { DoctorCheck } from "./core/doctor.ts";
import { assertBoardReady, boardDrift } from "./core/drift.ts";
import { runGc } from "./core/gc.ts";
import { isThinIssue, resolveMinBodyChars } from "./core/inputquality.ts";
import { defaultIssueTemplateResolveDeps } from "./core/issuetemplate.ts";
import { defaultMcpDeps, loadMcpServers } from "./core/mcp.ts";
import type { McpServer } from "./core/mcp.ts";
import {
    defaultAskConfirm,
    defaultAskQuestions,
    defaultAskTemplate,
    defaultEnrichIssue,
    newIssue,
} from "./core/newissue.ts";
import type { AskConfirm, AskQuestions, AskTemplate, EnrichIssue, NewIssueDeps } from "./core/newissue.ts";
import { createNotifier } from "./core/notify.ts";
import type { NotifyFormat } from "./core/notify.ts";
import { defaultPromptResolveDeps, loadEnrichPrompt, loadPromptSet } from "./core/prompts.ts";
import type { PromptSet } from "./core/prompts.ts";
import { resolveQualityGate } from "./core/qualitygate.ts";
import { queueView } from "./core/queue.ts";
import type { QueueRow } from "./core/queue.ts";
import { runReview } from "./core/review.ts";
import type { RunReviewDeps } from "./core/review.ts";
import { defaultOpenIssue, resolveRun, runIssue, runOpen, runSupervised } from "./core/run.ts";
import type { OpenIssue, ResolvedRun, RunIssueDeps, RunOpenDeps, RunSupervisedDeps } from "./core/run.ts";
import { listRecords, loadRecord, resolveRunsDir } from "./core/runstore.ts";
import type { RunStoreFs } from "./core/runstore.ts";
import { formatRunDetail, formatRunList } from "./core/runsview.ts";
import { setupProject } from "./core/setup.ts";
import { beflowBoardTemplate } from "./core/template.ts";
import { defaultPrChecks, defaultPrMerged, watch, watchTick } from "./core/watch.ts";
import type { WatchControl, WatchDeps } from "./core/watch.ts";
import { bunExec, expandHome, resolveWorktreeDir } from "./core/worktree.ts";
import type { Exec } from "./core/worktree.ts";
import type { Resolved } from "./model/types.ts";
import { createTracker } from "./trackers/factory.ts";
import type { Tracker } from "./trackers/tracker.ts";

export type WatchRunner = (projectKey: string, deps: WatchDeps, ctrl: WatchControl) => Promise<void>;

export type Ping = (config: Config, registry: Registry) => Promise<string>;

export interface CliDeps {
    loadConfig: (dir: string) => Config;
    loadRegistry: (dir: string) => Registry;
    createTracker: (config: Config, registry: Registry) => Tracker;
    createDriver: (acpxCommand: string[]) => AgentDriver;
    git?: Exec;
    launchInteractive?: RunSupervisedDeps["launchInteractive"];
    askOutcome?: RunSupervisedDeps["askOutcome"];
    askTemplate?: AskTemplate;
    askQuestions?: AskQuestions;
    askConfirm?: AskConfirm;
    // Test-injection seam: lets tests supply a fake enrich without a real driver,
    // mirroring the other optional IO seams above.
    enrich?: EnrichIssue;
    openIssue?: OpenIssue;
    // Test-injection seam for `beflow review <KEY>`; defaults to the real `runReview`.
    runReview?: (key: string, deps: RunReviewDeps) => Promise<unknown>;
    watch?: WatchRunner;
    // Test-injection seam for the read-only `runs` inspector; defaults to the real
    // Node fs-backed run store.
    runsFs?: RunStoreFs;
    // File-watcher for the `watch` command's config hot-reload. Defaults to the
    // Node fs watcher in production; tests omit it to skip real fs watching.
    configWatcher?: ConfigWatcher;
    fileExists?: (path: string) => boolean;
    onPath?: (cmd: string) => boolean;
    ping?: Ping;
    log?: (msg: string) => void;
    cwd?: string;
}

function notifyFormat(): NotifyFormat | undefined {
    const raw = process.env.BEFLOW_NOTIFY_FORMAT;
    if (raw === "slack" || raw === "discord" || raw === "generic") {
        return raw;
    }
    return undefined;
}

function onPathDefault(cmd: string): boolean {
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(":")) {
        if (dir === "") {
            continue;
        }
        if (existsSync(join(dir, cmd))) {
            return true;
        }
    }
    return false;
}

async function defaultPing(config: Config, registry: Registry): Promise<string> {
    const tracker = createTracker(config, registry);
    const first = Object.keys(registry.projects)[0];
    if (first === undefined) {
        throw new Error("no projects in registry");
    }
    const queue = await tracker.listQueue({ project: first, state: "Todo" });
    return `reached ${config.tracker}; ${String(queue.length)} Todo item(s) in ${first}`;
}

export function defaultCliDeps(): CliDeps {
    return {
        configWatcher: nodeConfigWatcher,
        createDriver: (acpxCommand) => new AcpxDriver({ command: acpxCommand }),
        createTracker: (config, registry) => createTracker(config, registry),
        fileExists: existsSync,
        git: bunExec,
        loadConfig,
        loadRegistry,
        onPath: onPathDefault,
        openIssue: defaultOpenIssue,
        ping: defaultPing,
        watch,
    };
}

interface RunArgs {
    agent?: string | undefined;
    repo?: string | undefined;
    auto?: boolean | undefined;
    attend?: boolean | undefined;
}

function cliOverrides(values: RunArgs): Partial<Resolved> {
    const cli: Partial<Resolved> = {};
    if (values.agent !== undefined) {
        cli.agent = values.agent;
    }
    if (values.repo !== undefined) {
        cli.repo = values.repo;
    }
    if (values.auto === true) {
        cli.runMode = "autonomous";
    } else if (values.attend === true) {
        cli.runMode = "supervised";
    }
    return cli;
}

interface CliContext {
    deps: CliDeps;
    dir: string;
    config: Config;
    registry: Registry;
    tracker: Tracker;
    prompts: PromptSet;
    log: (msg: string) => void;
    fail: (msg: string) => number;
}

// Builds the CliContext shared by every command that needs a tracker + prompts.
// Config is loaded here (inside command `run` handlers) rather than in `runCli`
// so that `--help` — which citty resolves without invoking `run` — works even
// when ~/beflow/config.json is missing or invalid.
function loadContext(deps: CliDeps, log: (msg: string) => void, fail: (msg: string) => number): CliContext {
    const dir = deps.cwd ?? configDir();
    const config = deps.loadConfig(dir);
    const registry = deps.loadRegistry(dir);
    const tracker = deps.createTracker(config, registry);
    const prompts = loadPromptSet(defaultPromptResolveDeps(dir, config.prompts?.dir));
    return { config, deps, dir, fail, log, prompts, registry, tracker };
}

function makeLog(deps: CliDeps): (msg: string) => void {
    return deps.log ?? ((msg: string): void => void process.stdout.write(`${msg}\n`));
}

function makeFail(): (msg: string) => number {
    return (msg: string): number => {
        process.stderr.write(`${msg}\n`);
        return 1;
    };
}

// citty's `ParsedArgs<ArgsDef>` values are loosely typed; these narrow a single
// parsed value to the concrete shape each command handler expects.
function asStr(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
    return typeof v === "boolean" ? v : undefined;
}

interface Cli {
    root: CommandDef;
    subCommands: Record<string, CommandDef>;
}

// Builds the citty command tree, closing over `deps` so the run handlers can
// inject their collaborators (citty's `run({ args })` carries no `deps`). We
// keep an explicit `subCommands` map so `runCli` can resolve the target command
// for help/dispatch without reaching into citty's loosely-typed `CommandDef`.
function buildCli(deps: CliDeps): Cli {
    function ctx(): CliContext {
        return loadContext(deps, makeLog(deps), makeFail());
    }

    const runCmd = defineCommand({
        args: {
            "agent": { description: "Override the resolved agent", type: "string" },
            "attend": { description: "interactive via acpx", type: "boolean" },
            "auto": { description: "headless via acpx", type: "boolean" },
            "dry-run": { description: "preview the plan without any side effects", type: "boolean" },
            "fresh": { description: "reset the run; ignore any saved session", type: "boolean" },
            "key": { description: "Work item key, e.g. CG-42", required: true, type: "positional" },
            "open": { description: "interactive via the agent's native TUI", type: "boolean" },
            "repo": { description: "Override the resolved repo", type: "string" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Run a work item through an agent", name: "run" },
        run: async ({ args }) =>
            cmdRun(
                {
                    agent: asStr(args.agent),
                    attend: asBool(args.attend),
                    auto: asBool(args.auto),
                    dryRun: asBool(args["dry-run"]),
                    fresh: asBool(args.fresh),
                    key: String(args.key),
                    open: asBool(args.open),
                    repo: asStr(args.repo),
                },
                ctx(),
            ),
    });

    // setup and update share the same args + handler (update is an alias). citty
    // has no first-class alias, so we register both subcommands with one handler.
    const setupArgs = {
        project: { description: "Registry project key, e.g. CG", required: true, type: "positional" },
        prune: { description: "delete orphan modules / agent: labels", type: "boolean" },
    } satisfies ArgsDef as ArgsDef;
    async function setupRun({ args }: CommandContext): Promise<number> {
        return cmdSetup({ project: String(args.project), prune: asBool(args.prune) }, ctx());
    }
    const setupCmd = defineCommand({
        args: setupArgs,
        meta: { description: "Provision/reconcile a project's board to the beflow template", name: "setup" },
        run: setupRun,
    });
    const updateCmd = defineCommand({
        args: setupArgs,
        meta: { description: "Alias of setup: reconcile a project's board to the template", name: "update" },
        run: setupRun,
    });

    const queueCmd = defineCommand({
        args: {
            project: { description: "Restrict to a single project key", type: "string" },
            state: { description: "Restrict to a single state name", type: "string" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Print the work queue across projects", name: "queue" },
        run: async ({ args }) => cmdQueue({ project: asStr(args.project), state: asStr(args.state) }, ctx()),
    });

    const watchCmd = defineCommand({
        args: {
            "dry-run": {
                description: "run a single tick and preview the decision without any side effects",
                type: "boolean",
            },
            "interval": { description: "Poll interval in seconds (default 30)", type: "string" },
            "project": { description: "Registry project key", required: true, type: "positional" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Continuously poll a project's queue and dispatch work", name: "watch" },
        run: async ({ args }) =>
            cmdWatch(
                { dryRun: asBool(args["dry-run"]), interval: asStr(args.interval), project: String(args.project) },
                ctx(),
            ),
    });

    const reviewCmd = defineCommand({
        args: {
            key: { description: "Work item key, e.g. CG-42", required: true, type: "positional" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Run an agent-driven review over a work item's open PR", name: "review" },
        run: async ({ args }) => cmdReview({ key: String(args.key) }, ctx()),
    });

    const runsCmd = defineCommand({
        args: {
            key: {
                description: "Work item key to inspect; omit to list all run records",
                required: false,
                type: "positional",
            },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Inspect persisted run records (read-only)", name: "runs" },
        run: ({ args }) => cmdRuns({ key: asStr(args.key) }, ctx()),
    });

    const acceptCmd = defineCommand({
        // Positional order is semantic: citty binds positionals by declaration
        // order, so `project` must come before `intake`. The sort-keys warning
        // this triggers is intentional — do not alphabetize these two keys.
        args: {
            project: { description: "Registry project key, e.g. CG", required: true, type: "positional" },
            intake: { description: "Intake item id", required: true, type: "positional" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Accept an intake item into the backlog", name: "accept" },
        run: async ({ args }) => cmdAccept({ intake: String(args.intake), project: String(args.project) }, ctx()),
    });

    const newCmd = defineCommand({
        args: {
            project: { description: "Registry project key, e.g. CG", required: true, type: "positional" },
            template: { description: "Issue template name (e.g. bug); omit to pick interactively", type: "positional" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Author a new work item from a template", name: "new" },
        run: async ({ args }) => cmdNew({ project: String(args.project), template: asStr(args.template) }, ctx()),
    });

    const doctorCmd = defineCommand({
        args: {
            ping: { description: "hit the tracker read API", type: "boolean" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Diagnose the local beflow environment", name: "doctor" },
        // doctor intentionally runs WITHOUT loadContext so it works with no config.
        run: async ({ args }) => cmdDoctor({ ping: asBool(args.ping) }, deps, deps.cwd ?? configDir(), makeLog(deps)),
    });

    const gcCmd = defineCommand({
        args: {
            "force": {
                description: "also remove worktrees with uncommitted/unpushed work (DESTROYS that work)",
                type: "boolean",
            },
            "older-than": { description: "only consider worktrees older than N days", type: "string" },
            "prune": { description: "actually remove orphan worktrees (default: report only)", type: "boolean" },
        } satisfies ArgsDef as ArgsDef,
        meta: { description: "Find and prune orphaned git worktrees beflow left behind", name: "gc" },
        // gc is a local disk op: like doctor, it runs WITHOUT loadContext (no tracker/API key).
        run: async ({ args }) =>
            cmdGc(
                { force: asBool(args.force), olderThan: asStr(args["older-than"]), prune: asBool(args.prune) },
                deps,
                deps.cwd ?? configDir(),
                makeLog(deps),
            ),
    });

    const subCommands: Record<string, CommandDef> = {
        accept: acceptCmd,
        doctor: doctorCmd,
        gc: gcCmd,
        new: newCmd,
        queue: queueCmd,
        review: reviewCmd,
        run: runCmd,
        runs: runsCmd,
        setup: setupCmd,
        update: updateCmd,
        watch: watchCmd,
    };
    const root = defineCommand({
        meta: { description: "beflow — drive work items through coding agents", name: "beflow" },
        subCommands,
    });
    return { root, subCommands };
}

// Test seam + entrypoint. `argv` is the raw arg list WITHOUT node/script (e.g.
// ["run", "BFT-9", "--open"]). Returns 0 on success, 1 on failure, writes
// errors to stderr. citty does NOT auto-handle `--help` through `runCommand`
// (only `runMain` does, and it calls `process.exit`), so we detect help
// ourselves and render usage via the exported `showUsage` without exiting.
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
    const cli = buildCli(deps);
    try {
        const target = resolveCliTarget(cli, argv);
        if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
            await showUsage(target.cmd, target.parent);
            return 0;
        }
        // Dispatch directly to the resolved subcommand so its `run` return value
        // (the exit code) propagates — citty's `runCommand` discards a
        // subcommand's result when it recurses internally.
        const r =
            target.cmd === cli.root
                ? await runCommand(cli.root, { rawArgs: argv })
                : await runCommand(target.cmd, { rawArgs: target.rest });
        return typeof r.result === "number" ? r.result : 0;
    } catch (err) {
        process.stderr.write(`beflow: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
    }
}

interface CliTarget {
    cmd: CommandDef;
    parent: CommandDef | undefined;
    rest: string[];
}

// Resolves which (sub)command `argv` addresses. Returns the root itself when the
// first token is not a known subcommand, letting `runCommand`/`showUsage` handle
// the unknown-command / top-level-help cases natively.
function resolveCliTarget(cli: Cli, argv: string[]): CliTarget {
    const first = argv[0];
    if (first !== undefined && !first.startsWith("-")) {
        const sub = cli.subCommands[first];
        if (sub !== undefined) {
            return { cmd: sub, parent: cli.root, rest: argv.slice(1) };
        }
    }
    return { cmd: cli.root, parent: undefined, rest: argv };
}

async function cmdRun(
    args: RunArgs & { key: string; open?: boolean; fresh?: boolean; dryRun?: boolean },
    ctx: CliContext,
): Promise<number> {
    const { deps, config, registry, tracker, prompts, log } = ctx;
    const { key } = args;
    const cli = cliOverrides(args);
    const fmt = notifyFormat();
    const notify = createNotifier({
        ...(fmt !== undefined ? { format: fmt } : {}),
        log,
        webhookUrl: process.env.BEFLOW_NOTIFY_WEBHOOK,
    });

    const preResolved: ResolvedRun = await resolveRun(key, cli, config, registry, tracker);

    if (args.dryRun === true) {
        printRunPlan(key, preResolved, ctx);
        return 0;
    }

    await assertBoardReady(projectKeyOf(key), tracker, log);

    // Acpx-driven runs (--auto / --attend) get the `.mcp.json` cascade injected as
    // `.acpxrc.json`; --open is the agent's native client and is left untouched.
    const mcpServers = config.mcp?.enabled === true ? loadMcpServers(defaultMcpDeps(ctx.dir)) : [];

    if (args.open === true) {
        const openDeps: RunOpenDeps = {
            tracker,
            config,
            registry,
            prompts,
            ...(deps.openIssue !== undefined ? { openIssue: deps.openIssue } : {}),
            ...(deps.askOutcome !== undefined ? { askOutcome: deps.askOutcome } : {}),
            log,
            notify,
            preResolved,
        };
        await runOpen(key, cli, openDeps);
        return 0;
    }

    if (preResolved.resolved.runMode === "autonomous") {
        const runDeps: RunIssueDeps = {
            config,
            driver: deps.createDriver(resolveAcpxCommand(config)),
            fresh: args.fresh === true,
            git: deps.git,
            log,
            notify,
            preResolved,
            prompts,
            promptResolveDeps: defaultPromptResolveDeps(ctx.dir, config.prompts?.dir),
            registry,
            tracker,
            ...(mcpServers.length > 0 ? { mcpServers } : {}),
        };
        const result = await runIssue(key, cli, runDeps);
        log(`beflow: ${key} done (status: ${result.result.report?.status ?? "no report"})`);
        return 0;
    }

    const supervisedDriver = deps.createDriver(resolveAcpxCommand(config));
    const supervisedDeps: RunSupervisedDeps = {
        askOutcome: deps.askOutcome,
        config,
        ensureSession: async (sessionName, sessionCwd, acpCommand) =>
            supervisedDriver.ensureSession(sessionName, sessionCwd, acpCommand),
        launchInteractive: deps.launchInteractive,
        log,
        notify,
        preResolved,
        prompts,
        registry,
        tracker,
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
    };
    const result = await runSupervised(key, cli, supervisedDeps);
    log(`beflow: ${key} done (status: ${result.report.status})`);
    return 0;
}

// Renders the read-only `run --dry-run` plan: what beflow WOULD do (resolution +
// applicable gates), with zero side effects. Mirrors the resolution `runIssue`
// performs but stops before any claim, board mutation, or agent dispatch.
function printRunPlan(key: string, preResolved: ResolvedRun, ctx: CliContext): void {
    const { config, registry, log } = ctx;
    const { issue, resolved } = preResolved;
    const projectKey = projectKeyOf(key);
    const model = config.agents[resolved.agent]?.model;
    log(`beflow: DRY RUN — ${key} (no side effects)`);
    log(`  jobKind: ${resolved.jobKind}`);
    log(`  agent: ${resolved.agent}${model !== undefined ? ` (model: ${model})` : " (default model)"}`);
    log(`  repo: ${resolved.repo} (${resolved.repoPath})`);
    log(`  runMode: ${resolved.runMode}`);
    log("  would create worktree for an autonomous run");
    if (isDecisionHeld(issue.labels)) {
        log("  gate: decision-hold — would park to Needs Input (needs-decision label present)");
    }
    if (isThinIssue(issue.body, resolveMinBodyChars(config, registry, projectKey))) {
        log("  gate: thin-issue — would park to Needs Input (description too thin)");
    }
    const gateCommands = resolveQualityGate(config, registry, projectKey);
    if (gateCommands.length > 0) {
        log(`  gate: quality — would run: ${gateCommands.join("; ")}`);
    }
}

async function cmdReview(args: { key: string }, ctx: CliContext): Promise<number> {
    const { deps, config, registry, tracker, prompts, log } = ctx;
    const { key } = args;
    const review = deps.runReview ?? runReview;
    const reviewDeps: RunReviewDeps = {
        config,
        driver: deps.createDriver(resolveAcpxCommand(config)),
        git: deps.git,
        log,
        prompts,
        registry,
        reviewSha: async (prUrl) => (await defaultPrChecks(prUrl)).sha,
        tracker,
    };
    await review(key, reviewDeps);
    return 0;
}

// Read-only run-record inspector. With a KEY it prints that record's detail; with
// None it lists every record. Touches only the local run store — no tracker calls,
// No mutation.
function cmdRuns(args: { key?: string | undefined }, ctx: CliContext): number {
    const { deps, config, log, fail } = ctx;
    const runsDir = resolveRunsDir(config.runs?.dir);
    if (args.key !== undefined) {
        const record =
            deps.runsFs !== undefined ? loadRecord(runsDir, args.key, deps.runsFs) : loadRecord(runsDir, args.key);
        if (record === null) {
            return fail(`beflow: no run record for "${args.key}"`);
        }
        const model = config.agents[record.agent]?.model;
        for (const line of formatRunDetail(record, model)) {
            log(line);
        }
        return 0;
    }
    const records = deps.runsFs !== undefined ? listRecords(runsDir, deps.runsFs) : listRecords(runsDir);
    for (const line of formatRunList(records)) {
        log(line);
    }
    return 0;
}

async function cmdSetup(args: { project: string; prune?: boolean | undefined }, ctx: CliContext): Promise<number> {
    const { deps, tracker, config, registry, dir, log } = ctx;
    const agents = [...new Set([config.agent, ...Object.keys(config.agents)])].sort();
    await setupProject(args.project, {
        agents,
        dir,
        log,
        prune: args.prune === true,
        registry,
        ...(deps.runsFs !== undefined ? { scaffoldFs: deps.runsFs } : {}),
        tracker,
        trackerName: config.tracker,
    });
    return 0;
}

async function cmdQueue(
    args: { project?: string | undefined; state?: string | undefined },
    ctx: CliContext,
): Promise<number> {
    const { tracker, registry, log } = ctx;
    const rows = await queueView(
        { registry, tracker },
        {
            ...(args.project !== undefined ? { projects: [args.project] } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
        },
    );
    printQueue(rows, log);
    return 0;
}

async function cmdWatch(
    args: { project: string; interval?: string | undefined; dryRun?: boolean | undefined },
    ctx: CliContext,
): Promise<number> {
    const { deps, config, registry, tracker, prompts, log, fail } = ctx;
    const projectKey = args.project;
    const intervalSec = args.interval !== undefined ? Number(args.interval) : 30;
    if (Number.isNaN(intervalSec) || intervalSec <= 0) {
        return fail(`beflow: invalid --interval "${String(args.interval)}"`);
    }

    try {
        await assertBoardReady(projectKey, tracker, log);
    } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }

    // Hot-reload: the watch loop is the only long-running command, so it gets a
    // ConfigStore that re-reads config.json on change. The store reuses the
    // Injected loaders so test seams keep working; production gets live reload.
    const store = new ConfigStore(ctx.dir, {
        loadConfig: deps.loadConfig,
        loadRegistry: deps.loadRegistry,
        log,
        ...(deps.configWatcher !== undefined ? { watcher: deps.configWatcher } : {}),
    });
    store.init();
    if (deps.configWatcher !== undefined) {
        store.start();
    }

    const watchFmt = notifyFormat();
    const watchMcpServers: McpServer[] = config.mcp?.enabled === true ? loadMcpServers(defaultMcpDeps(ctx.dir)) : [];
    const watchDeps: WatchDeps = {
        config,
        driver: deps.createDriver(resolveAcpxCommand(config)),
        getSnapshot: () => store.get(),
        git: deps.git,
        log,
        notify: createNotifier({
            ...(watchFmt !== undefined ? { format: watchFmt } : {}),
            log,
            webhookUrl: process.env.BEFLOW_NOTIFY_WEBHOOK,
        }),
        prChecks: defaultPrChecks,
        prMerged: defaultPrMerged,
        prompts,
        registry,
        tracker,
        ...(args.dryRun === true ? { dryRun: true } : {}),
        ...(watchMcpServers.length > 0 ? { mcpServers: watchMcpServers } : {}),
    };

    // --dry-run: a single read-only tick previews the dispatch decision with zero
    // Side effects (no loop, no mutating passes). watchTick honors deps.dryRun.
    if (args.dryRun === true) {
        try {
            await watchTick(projectKey, watchDeps);
        } finally {
            store.stop();
        }
        return 0;
    }

    let stopped = false;
    function onSigint(): void {
        stopped = true;
    }
    process.once("SIGINT", onSigint);
    const runner = deps.watch ?? watch;
    try {
        await runner(projectKey, watchDeps, {
            shouldStop: () => stopped,
            sleepMs: intervalSec * 1000,
        });
    } finally {
        process.removeListener("SIGINT", onSigint);
        store.stop();
    }
    return 0;
}

async function cmdAccept(args: { project: string; intake: string }, ctx: CliContext): Promise<number> {
    const { tracker, log } = ctx;
    const item = await acceptIntake(args.project, args.intake, { log, tracker });
    log(`beflow: ${args.project} accepted ${item.id} → Backlog`);
    return 0;
}

async function cmdNew(args: { project: string; template?: string | undefined }, ctx: CliContext): Promise<number> {
    const templateDeps = defaultIssueTemplateResolveDeps(ctx.dir, ctx.config.prompts?.dir);
    const enrich = resolveEnrich(args.project, ctx);
    const deps: NewIssueDeps = {
        askConfirm: ctx.deps.askConfirm ?? defaultAskConfirm,
        askQuestions: ctx.deps.askQuestions ?? defaultAskQuestions,
        askTemplate: ctx.deps.askTemplate ?? defaultAskTemplate,
        log: ctx.log,
        templateDeps,
        tracker: ctx.tracker,
        ...(enrich !== undefined ? { enrich } : {}),
    };
    await newIssue(args.project, args.template, deps);
    return 0;
}

// Resolves the agent-enrich boundary for `beflow new`. Prefers a test-injected
// enrich; otherwise builds the read-only driver-backed one when the project's
// default_repo path resolves. Returns undefined (→ form draft) when no repo path
// is available, warning so enrich:true templates degrade visibly.
function resolveEnrich(project: string, ctx: CliContext): EnrichIssue | undefined {
    if (ctx.deps.enrich !== undefined) {
        return ctx.deps.enrich;
    }
    const proj = ctx.registry.projects[project];
    const repoName = proj?.default_repo;
    const rawPath = repoName !== undefined ? proj?.repos[repoName] : undefined;
    if (rawPath === undefined) {
        ctx.log(`beflow: no default_repo path for "${project}"; enrich:true templates will use the form draft`);
        return undefined;
    }
    const enrichPrompt = loadEnrichPrompt(defaultPromptResolveDeps(ctx.dir, ctx.config.prompts?.dir));
    return defaultEnrichIssue({
        defaultAgent: ctx.config.agent,
        driver: ctx.deps.createDriver(resolveAcpxCommand(ctx.config)),
        enrichPrompt,
        log: ctx.log,
        repoPath: expandHome(rawPath),
        resolveAcp: (a) => resolveAcpCommand(a, ctx.config.agents[a]),
    });
}

async function cmdDoctor(
    args: { ping?: boolean | undefined },
    deps: CliDeps,
    dir: string,
    log: (msg: string) => void,
): Promise<number> {
    const fileExists = deps.fileExists ?? existsSync;
    const onPath = deps.onPath ?? onPathDefault;
    const checks = await doctor({
        env: process.env,
        fileExists,
        loadConfig: () => deps.loadConfig(dir),
        loadRegistry: () => deps.loadRegistry(dir),
        onPath,
        ...(args.ping === true && deps.ping !== undefined
            ? {
                  boardChecks: async (): Promise<DoctorCheck[]> => boardChecks(deps, dir),
                  ping: deps.ping,
              }
            : {}),
    });

    for (const check of checks) {
        log(`${checkGlyph(check.level)} ${check.name} — ${check.detail}`);
    }
    return checks.some((c) => c.level === "fail") ? 1 : 0;
}

async function cmdGc(
    args: { prune?: boolean | undefined; force?: boolean | undefined; olderThan?: string | undefined },
    deps: CliDeps,
    dir: string,
    log: (msg: string) => void,
): Promise<number> {
    if (deps.git === undefined) {
        return makeFail()("beflow: gc requires git, but no git executor is configured");
    }
    const config = deps.loadConfig(dir);
    const worktreesDir = resolveWorktreeDir(config.worktrees?.dir);
    const runsDir = resolveRunsDir(config.runs?.dir);

    let olderThanDays: number | undefined;
    if (args.olderThan !== undefined) {
        const parsed = Number(args.olderThan);
        if (Number.isNaN(parsed) || parsed <= 0) {
            return makeFail()(`beflow: invalid --older-than "${args.olderThan}" (expected a positive number of days)`);
        }
        olderThanDays = parsed;
    }

    await runGc({
        force: args.force === true,
        git: deps.git,
        log,
        prune: args.prune === true,
        runsDir,
        worktreesDir,
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
    });
    return 0;
}

async function boardChecks(deps: CliDeps, dir: string): Promise<DoctorCheck[]> {
    const config = deps.loadConfig(dir);
    const registry = deps.loadRegistry(dir);
    const agents = [...new Set([config.agent, ...Object.keys(config.agents)])].sort();
    const tracker = deps.createTracker(config, registry);

    const checks: DoctorCheck[] = [];
    for (const key of Object.keys(registry.projects)) {
        const template = beflowBoardTemplate(registry, key, agents);
        try {
            const board = await tracker.inspectBoard(key);
            const drift = boardDrift(template, board);
            const missing = drift.missingStates.length + drift.missingLabels.length + drift.missingModules.length;
            if (missing === 0) {
                const hint =
                    drift.extraStates.length > 0 ? ` (unexpected states present: ${drift.extraStates.join(", ")})` : "";
                checks.push({
                    detail: `matches template${hint}`,
                    level: "pass",
                    name: `board:${key}`,
                });
            } else {
                const parts: string[] = [];
                if (drift.missingStates.length > 0) {
                    parts.push(`missing state(s): ${drift.missingStates.join(", ")}`);
                }
                if (drift.missingLabels.length > 0) {
                    parts.push(`label(s): ${drift.missingLabels.join(", ")}`);
                }
                if (drift.missingModules.length > 0) {
                    parts.push(`module(s): ${drift.missingModules.join(", ")}`);
                }
                const extra =
                    drift.extraStates.length > 0
                        ? ` — unexpected states present: ${drift.extraStates.join(", ")} (renamed?)`
                        : "";
                checks.push({
                    detail: `${parts.join("; ")}${extra}`,
                    level: "fail",
                    name: `board:${key}`,
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            checks.push({
                detail: `could not inspect: ${msg}`,
                level: "warn",
                name: `board:${key}`,
            });
        }
    }
    return checks;
}

function checkGlyph(level: DoctorCheck["level"]): string {
    const glyphs: Record<DoctorCheck["level"], string> = {
        fail: "✗",
        pass: "✓",
        warn: "!",
    };
    return glyphs[level];
}

function printQueue(rows: QueueRow[], log: (msg: string) => void): void {
    if (rows.length === 0) {
        log("beflow: queue empty");
        return;
    }
    const cells = rows.map((r) => ({
        key: r.key,
        priority: r.priority ?? "",
        project: r.project,
        state: r.state,
        title: r.title,
    }));
    const widths = {
        key: colWidth(cells, "key", "KEY"),
        priority: colWidth(cells, "priority", "PRIORITY"),
        project: colWidth(cells, "project", "PROJECT"),
        state: colWidth(cells, "state", "STATE"),
    };
    log(
        `${"PROJECT".padEnd(widths.project)}  ${"KEY".padEnd(widths.key)}  ${"STATE".padEnd(widths.state)}  ${"PRIORITY".padEnd(widths.priority)}  TITLE`,
    );
    for (const c of cells) {
        log(
            `${c.project.padEnd(widths.project)}  ${c.key.padEnd(widths.key)}  ${c.state.padEnd(widths.state)}  ${c.priority.padEnd(widths.priority)}  ${c.title}`,
        );
    }
}

function colWidth(cells: Record<string, string>[], key: string, header: string): number {
    return cells.reduce((w, c) => Math.max(w, (c[key] ?? "").length), header.length);
}

function projectKeyOf(issueKey: string): string {
    const dash = issueKey.lastIndexOf("-");
    return dash === -1 ? issueKey : issueKey.slice(0, dash);
}

if (import.meta.main) {
    void runCli(process.argv.slice(2), defaultCliDeps()).then((code) => {
        process.exit(code);
    });
}
