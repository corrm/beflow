export type { StateGroup, RunMode, JobKind, Issue, IssueMeta, Resolved } from "./model/types.ts";

export {
    configSchema,
    fileSchema,
    registrySchema,
    projectSchema,
    agentConfigSchema,
    type Config,
    type ConfigFile,
    type Registry,
    type Project,
    type AgentConfig,
} from "./config/schema.ts";

export { loadConfig, loadRegistry } from "./config/load.ts";

export { parseIssueMeta } from "./resolve/metadata.ts";

export { autoDetectJobKind } from "./resolve/jobkind.ts";

export {
    cascade,
    resolve,
    resolveAgent,
    resolveRunMode,
    resolveRepo,
    resolveJobKind,
    type ResolveInputs,
} from "./resolve/precedence.ts";

export type {
    Tracker,
    QueueFilter,
    IntakeItem,
    BoardTemplate,
    EnsureBoardResult,
    Comment,
} from "./trackers/tracker.ts";

export { BEFLOW_MARKER, withMarker, hasMarker, stripMarker } from "./trackers/marker.ts";

export { PlaneTracker, createPlaneTracker, type PlaneTrackerOptions } from "./trackers/plane/adapter.ts";

export { PlaneClient, type PlaneClientOptions } from "./trackers/plane/client.ts";

export { LinearTracker, createLinearTracker, type LinearTrackerOptions } from "./trackers/linear/adapter.ts";

export { LinearSdkGateway, type LinearGateway, type ListIssuesQuery } from "./trackers/linear/client.ts";

export { createTracker } from "./trackers/factory.ts";

export { extractReport, type Report, type ReportStatus } from "./agent/report.ts";

export { parseAcpLine, reduceAcpStream, type AcpStreamResult, type AcpToolCall } from "./agent/events.ts";

export {
    AcpxDriver,
    BunProcessRunner,
    buildAcpxArgs,
    buildCancelArgs,
    type ProcessRunner,
    type SpawnedProcess,
} from "./agent/acpx.ts";

export type { AgentDriver, AgentRunResult, RunOptions } from "./agent/driver.ts";

export {
    PROMPT_NAMES,
    buildPromptContext,
    defaultPromptResolveDeps,
    loadPromptSet,
    renderContract,
    renderTask,
    renderTemplate,
    type PromptName,
    type PromptResolveDeps,
    type PromptSet,
} from "./core/prompts.ts";

export { applyReport, defaultDoneState, type WritebackResult } from "./core/writeback.ts";

export {
    createWorktree,
    removeWorktree,
    worktreePath,
    sanitizeKey,
    bunExec,
    type Exec,
    type ExecResult,
} from "./core/worktree.ts";

export {
    resolveRun,
    runIssue,
    runOpen,
    runSupervised,
    defaultOpenIssue,
    type ResolvedRun,
    type RunIssueDeps,
    type RunOpenDeps,
    type RunResult,
    type RunSupervisedDeps,
    type SupervisedResult,
    type OpenIssue,
    type OpenLaunch,
    type Logger,
    type LaunchInteractive,
    type InteractiveLaunch,
    type AskOutcome,
    type OutcomeAnswer,
} from "./core/run.ts";

export { beflowBoardTemplate } from "./core/template.ts";

export {
    assembleContinuation,
    renderContinuation,
    type AssembleOptions,
    type ContinuationContext,
} from "./core/continuation.ts";

export {
    loadRecord,
    saveRecord,
    deleteRecord,
    resolveRunsDir,
    systemClock,
    nodeRunStoreFs,
    reportSchema,
    runRecordSchema,
    type RunRecord,
    type RunStoreFs,
    type Clock,
} from "./core/runstore.ts";

export { setupProject, type SetupDeps } from "./core/setup.ts";

export { queueView, type QueueRow, type QueueDeps, type QueueOptions } from "./core/queue.ts";

export { acceptIntake, type AcceptDeps } from "./core/accept.ts";

export { doctor, type DoctorCheck, type DoctorDeps, type CheckLevel } from "./core/doctor.ts";

export {
    watch,
    watchTick,
    type WatchDeps,
    type WatchControl,
    type WatchAction,
    type WatchTickResult,
} from "./core/watch.ts";

export { runCli, defaultCliDeps, type CliDeps, type WatchRunner, type Ping } from "./cli.ts";
