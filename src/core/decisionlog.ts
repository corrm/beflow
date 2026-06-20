import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PolicyDecision } from "../model/types.ts";
import type { MatchedRule } from "./policy.ts";
import type { RunStoreFs } from "./runstore.ts";
import { nodeRunStoreFs } from "./runstore.ts";
import { expandHome } from "./worktree.ts";

const SCHEMA_VERSION = 1;

/**
 * The canonical, durable record of one post-run policy decision. Designed as a
 * self-contained EVENT so an external sink (object storage, SIEM) is a pure later
 * drop-in: the shape never depends on where it is written. `evidence` and
 * `approver` are reserved for receipt-aware population in a later issue.
 */
export interface DecisionEvent {
    schemaVersion: number;
    decisionId: string;
    runId: string;
    key: string;
    prUrl?: string;
    decision: PolicyDecision;
    evaluator: string;
    matchedRules: MatchedRule[];
    changedFiles: string[];
    reason: string;
    timestamp: string;
    /** SHA-256 over the sorted changed-file paths — cheap tamper-evidence. */
    changedFilesHash: string;
    /** SHA-256 over the decision inputs (key, decision, evaluator, rules, files). */
    decisionInputHash: string;
    evidence?: unknown;
    approver?: string;
}

/**
 * The append-only decision sink: a stable contract with swappable implementations.
 * The sink changes (local NDJSON now; object storage / SIEM later, each a NEW
 * class — never a schema change); the `DecisionEvent` it carries does not.
 */
export interface DecisionSink {
    emit(event: DecisionEvent): Promise<void>;
}

/** Resolve the decision-log base dir: a sibling of the runs dir under `~/.beflow`. */
export function resolveDecisionsDir(configured?: string): string {
    return configured !== undefined ? expandHome(configured) : join(homedir(), ".beflow", "decisions");
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function hashChangedFiles(changedFiles: string[]): string {
    return sha256([...changedFiles].sort().join("\n"));
}

/** The inputs that determined the decision, hashed for a tamper-evident log. */
export interface DecisionInput {
    key: string;
    decision: PolicyDecision;
    evaluator: string;
    matchedRules: MatchedRule[];
    changedFiles: string[];
    reason: string;
}

function hashDecisionInput(input: DecisionInput): string {
    return sha256(
        JSON.stringify({
            changedFiles: [...input.changedFiles].sort(),
            decision: input.decision,
            evaluator: input.evaluator,
            key: input.key,
            matchedRules: input.matchedRules,
            reason: input.reason,
        }),
    );
}

/** Inputs the caller supplies; the event's ids, hashes, and version are derived. */
export interface NewDecisionEvent {
    runId: string;
    key: string;
    prUrl?: string;
    decision: PolicyDecision;
    evaluator: string;
    matchedRules: MatchedRule[];
    changedFiles: string[];
    reason: string;
}

/** Build a complete `DecisionEvent`, deriving the ids, hashes, and timestamp. */
export function buildDecisionEvent(
    input: NewDecisionEvent,
    now: () => string,
    decisionId: () => string = randomUUID,
): DecisionEvent {
    return {
        changedFiles: input.changedFiles,
        changedFilesHash: hashChangedFiles(input.changedFiles),
        decision: input.decision,
        decisionId: decisionId(),
        decisionInputHash: hashDecisionInput(input),
        evaluator: input.evaluator,
        key: input.key,
        matchedRules: input.matchedRules,
        reason: input.reason,
        runId: input.runId,
        schemaVersion: SCHEMA_VERSION,
        timestamp: now(),
        ...(input.prUrl !== undefined ? { prUrl: input.prUrl } : {}),
    };
}

/**
 * The only concrete sink this build ships: an append-only NDJSON log, one event
 * per line, that outlives the run-record GC. Built over `RunStoreFs` so it is
 * testable in-memory and never overwrites (read-append-write keeps the file
 * monotonic). A future `ObjectStorageSink` / `SiemSink` is a new class behind the
 * same `DecisionSink` interface, not a change here.
 */
export class LocalNdjsonSink implements DecisionSink {
    public constructor(
        private readonly dir: string,
        private readonly fs: RunStoreFs = nodeRunStoreFs,
    ) {}

    public async emit(event: DecisionEvent): Promise<void> {
        const path = join(this.dir, "decisions.ndjson");
        const prior = this.fs.read(path) ?? "";
        this.fs.write(path, `${prior}${JSON.stringify(event)}\n`);
        return Promise.resolve();
    }
}
