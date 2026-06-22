import { LinearClient } from "@linear/sdk";

import { configPath } from "../../config/paths.ts";
import type { Config, Registry } from "../../config/schema.ts";
import type { Issue, IssueMeta } from "../../model/types.ts";
import { parseIssueMeta } from "../../resolve/metadata.ts";
import { hasMarker, stripMarker, withMarker } from "../marker.ts";
import type {
    BlockerRef,
    BoardState,
    BoardTemplate,
    Comment,
    EnsureBoardOptions,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ProjectCreateResult,
    ProjectCreateSpec,
    QueueFilter,
    Tracker,
} from "../tracker.ts";
import { IssueNotFoundError } from "../tracker.ts";
import { DEFAULT_STATE_COLOR, LinearSdkGateway } from "./client.ts";
import type { CreateIssueInput, LinearGateway } from "./client.ts";
import { mapIntakeItem, mapIssue, priorityRank, priorityToInt } from "./map.ts";
import type { RawLabel, RawWorkflowState } from "./types.ts";

interface TeamCaches {
    statesById: Map<string, RawWorkflowState>;
    statesByName: Map<string, RawWorkflowState>;
    labelsById: Map<string, RawLabel>;
    labelsByName: Map<string, RawLabel>;
}

export interface LinearTrackerOptions {
    gateway: LinearGateway;
    registry: Registry;
    apiKeyEnv: string;
}

// Linear seeds a default "Canceled" state (American spelling); beflow's template
// uses "Cancelled". Canonicalize so ensureBoard reconciles against the existing
// state instead of creating a duplicate cancelled-group state. (Lower-casing also
// makes the existence check case-insensitive, which only helps avoid dup states.)
function canonicalStateName(name: string): string {
    return name.toLowerCase().replace("canceled", "cancelled");
}

export class LinearTracker implements Tracker {
    private readonly gateway: LinearGateway;
    private readonly registry: Registry;
    private readonly apiKeyEnv: string;
    private readonly caches = new Map<string, TeamCaches>();

    public constructor(options: LinearTrackerOptions) {
        this.gateway = options.gateway;
        this.registry = options.registry;
        this.apiKeyEnv = options.apiKeyEnv;
    }

    // For Linear the registry project key IS the Linear team key (e.g. "CG").
    private resolveTeamKey(key: string): string {
        const project = this.registry.projects[key];
        if (project === undefined) {
            const known = Object.keys(this.registry.projects).join(", ");
            throw new Error(`linear: unknown project key "${key}" (known: ${known})`);
        }
        return key;
    }

    private teamKeyOfIssue(issueKey: string): string {
        const dash = issueKey.lastIndexOf("-");
        if (dash === -1) {
            throw new Error(`linear: malformed issue key "${issueKey}"`);
        }
        return this.resolveTeamKey(issueKey.slice(0, dash));
    }

    private async loadCaches(teamKey: string): Promise<TeamCaches> {
        const cached = this.caches.get(teamKey);
        if (cached) {
            return cached;
        }

        const [states, labels] = await Promise.all([
            this.gateway.listStates(teamKey),
            this.gateway.listLabels(teamKey),
        ]);

        const caches: TeamCaches = {
            labelsById: new Map(labels.map((l) => [l.id, l])),
            labelsByName: new Map(labels.map((l) => [l.name, l])),
            statesById: new Map(states.map((s) => [s.id, s])),
            statesByName: new Map(states.map((s) => [s.name, s])),
        };
        this.caches.set(teamKey, caches);
        return caches;
    }

    public async getIssue(key: string): Promise<Issue> {
        this.teamKeyOfIssue(key);
        try {
            const raw = await this.gateway.getIssueByIdentifier(key);
            return mapIssue(raw);
        } catch (err) {
            if (isLinearNotFound(err)) {
                throw new IssueNotFoundError(key);
            }
            throw err;
        }
    }

    public async blockedBy(issue: Issue): Promise<BlockerRef[]> {
        const blockers = await this.gateway.getBlockers(issue.id);
        return blockers.map((b) => ({
            done: b.stateType === "completed" || b.stateType === "cancelled",
            key: b.identifier,
        }));
    }

    public async issueContext(_issue: Issue): Promise<IssueContext> {
        // REMAINING DOCUMENTED PARITY GAP (not a forgotten stub): linked-context fetch
        // (parent epic + attachments) is Plane-only today and not yet wired for Linear.
        // A safe degradation — Linear reports no context — tracked under Linear parity.
        return Promise.resolve({ attachments: [] });
    }

    public async createIssue(project: string, draft: IssueDraft): Promise<Issue> {
        const teamKey = this.resolveTeamKey(project);
        const caches = await this.loadCaches(teamKey);

        // Linear has no native work-item type, so draft.type is carried as a label
        // (mirrors mapIssue, which leaves Issue.type undefined and treats labels as
        // The type/area carrier). The names below are resolved through the team caches.
        const labelNames = [...(draft.labels ?? [])];
        if (draft.type !== undefined) {
            labelNames.push(draft.type);
        }

        const labelIds: string[] = [];
        for (const name of labelNames) {
            const label = caches.labelsByName.get(name);
            if (label === undefined) {
                const known = [...caches.labelsByName.keys()].join(", ");
                throw new Error(`linear: unknown label name "${name}" in team ${teamKey} (known: ${known})`);
            }
            labelIds.push(label.id);
        }

        const input: CreateIssueInput = {
            description: draft.body,
            priority: priorityToInt(draft.priority),
            title: draft.title,
        };

        if (labelIds.length > 0) {
            input.labelIds = labelIds;
        }

        if (draft.state !== undefined) {
            const state = caches.statesByName.get(draft.state);
            if (state === undefined) {
                const known = [...caches.statesByName.keys()].join(", ");
                throw new Error(`linear: unknown state name "${draft.state}" in team ${teamKey} (known: ${known})`);
            }
            input.stateId = state.id;
        }

        if (draft.assigneeId !== undefined) {
            input.assigneeId = draft.assigneeId;
        }

        const raw = await this.gateway.createIssue(teamKey, input);
        return mapIssue(raw);
    }

    public async listQueue(filter: QueueFilter): Promise<Issue[]> {
        const teamKey = this.resolveTeamKey(filter.project);
        const raws = await this.gateway.listIssues(teamKey, {
            stateName: filter.state,
            stateType: filter.state === undefined ? filter.stateGroup : undefined,
        });
        const issues = raws.map((raw) => mapIssue(raw));

        return issues
            .map((issue, index) => ({ index, issue }))
            .sort((a, b) => {
                const byRank = priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
                return byRank !== 0 ? byRank : a.index - b.index;
            })
            .map((entry) => entry.issue);
    }

    public async activeCycleIssueIds(_project: string): Promise<Set<string> | null> {
        // REMAINING DOCUMENTED PARITY GAP (not a forgotten stub): cycle-aware scheduling
        // is Plane-only today and not yet wired for Linear; null = no cycle filter.
        return Promise.resolve(null);
    }

    public async updateState(issue: Issue, stateName: string): Promise<void> {
        const teamKey = this.teamKeyOfIssue(issue.key);
        const caches = await this.loadCaches(teamKey);
        const state = caches.statesByName.get(stateName);
        if (state === undefined) {
            const known = [...caches.statesByName.keys()].join(", ");
            throw new Error(`linear: unknown state name "${stateName}" in team ${teamKey} (known: ${known})`);
        }
        await this.gateway.updateIssueState(issue.id, state.id);
    }

    public async assign(issue: Issue, assigneeId: string): Promise<void> {
        await this.gateway.updateIssueAssignee(issue.id, assigneeId);
    }

    public async addProperty(issue: Issue, name: string): Promise<void> {
        const teamKey = this.teamKeyOfIssue(issue.key);
        const caches = await this.loadCaches(teamKey);
        const target = caches.labelsByName.get(name);
        if (target === undefined) {
            const known = [...caches.labelsByName.keys()].join(", ");
            throw new Error(`linear: unknown label name "${name}" in team ${teamKey} (known: ${known})`);
        }

        const ids = new Set<string>();
        for (const labelName of issue.labels) {
            const existing = caches.labelsByName.get(labelName);
            if (existing !== undefined) {
                ids.add(existing.id);
            }
        }
        ids.add(target.id);

        await this.gateway.updateIssueLabels(issue.id, [...ids]);
    }

    public async removeProperty(issue: Issue, name: string): Promise<void> {
        const teamKey = this.teamKeyOfIssue(issue.key);
        const caches = await this.loadCaches(teamKey);
        const target = caches.labelsByName.get(name);
        if (target === undefined || !issue.labels.includes(name)) {
            return;
        }

        const ids = new Set<string>();
        for (const labelName of issue.labels) {
            const existing = caches.labelsByName.get(labelName);
            if (existing !== undefined) {
                ids.add(existing.id);
            }
        }
        ids.delete(target.id);

        await this.gateway.updateIssueLabels(issue.id, [...ids]);
    }

    public async createProperty(teamKey: string, name: string, opts?: { color?: string }): Promise<void> {
        const key = this.resolveTeamKey(teamKey);
        const labels = await this.gateway.listLabels(key);
        if (labels.some((l) => l.name === name)) {
            return;
        }
        await this.gateway.createLabel(key, { color: opts?.color, name });
    }

    public async deleteProperty(teamKey: string, name: string): Promise<void> {
        const key = this.resolveTeamKey(teamKey);
        const labels = await this.gateway.listLabels(key);
        const label = labels.find((l) => l.name === name);
        if (label === undefined) {
            return;
        }
        await this.gateway.deleteLabel(label.id);
    }

    public async comment(issue: Issue, body: string): Promise<void> {
        // Linear comments take markdown directly — no HTML conversion.
        const marked = withMarker(body);
        // Idempotent: writeback is replayed on a resumed run, so don't post the
        // Same comment twice.
        const existing = await this.gateway.listComments(issue.id);
        if (existing.some((c) => c.body === marked)) {
            return;
        }
        await this.gateway.createComment(issue.id, marked);
    }

    public async listComments(issue: Issue): Promise<Comment[]> {
        const raws = await this.gateway.listComments(issue.id);
        return raws
            .map((r) => ({
                ...(r.authorId !== undefined ? { authorId: r.authorId } : {}),
                body: stripMarker(r.body),
                createdAt: r.createdAt,
                id: r.id,
                isBot: hasMarker(r.body),
            }))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    public async linkPR(issue: Issue, url: string, title?: string): Promise<void> {
        // Idempotent: writeback is replayed on a resumed run, so skip if this
        // URL is already attached.
        const existing = await this.gateway.listAttachments(issue.id);
        if (existing.some((a) => a.url === url)) {
            return;
        }
        await this.gateway.createAttachment(issue.id, url, title ?? "Pull Request");
    }

    public readMetadata(issue: Issue): IssueMeta {
        return parseIssueMeta(issue.body, issue.labels);
    }

    public async listInbox(project: string): Promise<IntakeItem[]> {
        const teamKey = this.resolveTeamKey(project);
        const raws = await this.gateway.listTriage(teamKey);
        return raws.map(mapIntakeItem);
    }

    public async acceptInbox(project: string, item: IntakeItem): Promise<void> {
        const teamKey = this.resolveTeamKey(project);
        const caches = await this.loadCaches(teamKey);
        const backlog = [...caches.statesById.values()].find((s) => s.type === "backlog");
        if (backlog === undefined) {
            throw new Error(`linear: team ${teamKey} has no backlog-type state to accept triage into`);
        }
        await this.gateway.updateIssueState(item.issueId, backlog.id);
    }

    public async inspectBoard(project: string): Promise<BoardState> {
        const teamKey = this.resolveTeamKey(project);
        const [states, labels] = await Promise.all([
            this.gateway.listStates(teamKey),
            this.gateway.listLabels(teamKey),
        ]);
        // Linear has no modules/types — empty arrays (mirrors ensureBoard).
        return { labels: labels.map((l) => l.name), modules: [], states: states.map((s) => s.name), types: [] };
    }

    public async ensureBoard(
        project: string,
        template: BoardTemplate,
        _opts?: EnsureBoardOptions,
    ): Promise<EnsureBoardResult> {
        const teamKey = this.resolveTeamKey(project);
        // Linear reconcile (update-drifted) and prune aren't implemented yet;
        // Create-only, with no orphan detection.
        const result: EnsureBoardResult = {
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        };

        const [states, labels] = await Promise.all([
            this.gateway.listStates(teamKey),
            this.gateway.listLabels(teamKey),
        ]);

        const stateNames = new Set(states.map((s) => canonicalStateName(s.name)));
        for (const state of template.states) {
            if (stateNames.has(canonicalStateName(state.name))) {
                result.skipped.push(`state:${state.name}`);
                continue;
            }
            await this.gateway.createState(teamKey, {
                color: state.color || DEFAULT_STATE_COLOR,
                name: state.name,
                type: state.group,
            });
            result.created.push(`state:${state.name}`);
        }

        const labelNames = new Set(labels.map((l) => l.name));
        for (const label of template.labels) {
            if (labelNames.has(label.name)) {
                result.skipped.push(`label:${label.name}`);
                continue;
            }
            await this.gateway.createLabel(teamKey, {
                color: label.color,
                name: label.name,
            });
            result.created.push(`label:${label.name}`);
        }

        if (template.modules.length > 0) {
            result.warnings.push(
                `linear: has no modules; skipped ${String(template.modules.length)} module(s) from the template (use labels for areas instead).`,
            );
        }
        if (template.types.length > 0) {
            result.warnings.push(
                `linear: has no work-item types; skipped ${String(template.types.length)} type(s) from the template.`,
            );
        }

        return result;
    }
    public async verifyAuth(): Promise<void> {
        try {
            await this.gateway.verifyAuth();
        } catch {
            throw new Error(`beflow: Linear token invalid — check ${this.apiKeyEnv} in ${configPath()}`);
        }
    }

    public async createProject(spec: ProjectCreateSpec): Promise<ProjectCreateResult> {
        const team = await this.gateway.createTeam({ key: spec.identifier, name: spec.name });
        return { trackerProjectId: team.id };
    }

    public async findProjectId(identifier: string): Promise<string | null> {
        return this.gateway.findTeamId(identifier.toUpperCase());
    }
}

export function createLinearTracker(
    config: Config,
    registry: Registry,
    env: NodeJS.ProcessEnv = process.env,
): LinearTracker {
    const linearConfig = config.trackers.linear;
    if (linearConfig === undefined) {
        throw new Error("linear: config.trackers.linear is not configured");
    }

    const apiKey = env[linearConfig.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
        throw new Error(`linear: API key env var "${linearConfig.apiKeyEnv}" is unset`);
    }

    const gateway = new LinearSdkGateway(new LinearClient({ apiKey }));
    return new LinearTracker({ apiKeyEnv: linearConfig.apiKeyEnv, gateway, registry });
}

// Message-based heuristic: the Linear SDK surfaces an unknown identifier as a
// generic error with no stable not-found discriminator, so we match on its text.
function isLinearNotFound(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /not found|could not find|entity not found/i.test(message);
}
