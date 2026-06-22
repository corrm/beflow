import { configPath } from "../../config/paths.ts";
import type { Config, Registry } from "../../config/schema.ts";
import type { Issue, IssueMeta } from "../../model/types.ts";
import { parseIssueMeta } from "../../resolve/metadata.ts";
import { hasMarker, stripMarker, withMarker } from "../marker.ts";
import type {
    Attachment,
    BlockerRef,
    BoardState,
    BoardTemplate,
    Comment,
    EnsureBoardOptions,
    EnsureBoardResult,
    IntakeItem,
    IssueContext,
    IssueDraft,
    ModuleChangeAction,
    ParentContext,
    ProjectCreateResult,
    ProjectCreateSpec,
    QueueFilter,
    Tracker,
} from "../tracker.ts";
import { IssueNotFoundError } from "../tracker.ts";
import { PlaneClient, PlaneHttpError } from "./client.ts";
import { mapIntakeItem, mapWorkItem, pickActiveCycle, priorityRank, toCommentHtml, unescapeHtml } from "./map.ts";
import type { MapContext } from "./map.ts";
import type { RawLabel, RawModule, RawState, RawWorkItemType } from "./types.ts";

interface ProjectRef {
    key: string; // Registry key === Plane project identifier (confirmed for CG)
    projectId: string; // Plane project_id (uuid)
}

interface ProjectCaches {
    statesById: Map<string, RawState>;
    statesByName: Map<string, RawState>;
    labelsById: Map<string, RawLabel>;
    labelsByName: Map<string, RawLabel>;
    modulesById: Map<string, RawModule>;
    typesById: Map<string, RawWorkItemType>;
    typesByName: Map<string, RawWorkItemType>;
}

export interface PlaneTrackerOptions {
    client: PlaneClient;
    registry: Registry;
    auth: { workspaceSlug: string; apiKeyEnv: string };
}

export class PlaneTracker implements Tracker {
    private readonly client: PlaneClient;
    private readonly registry: Registry;
    private readonly auth: { workspaceSlug: string; apiKeyEnv: string };
    private readonly caches = new Map<string, ProjectCaches>();

    public constructor(options: PlaneTrackerOptions) {
        this.client = options.client;
        this.registry = options.registry;
        this.auth = options.auth;
    }

    private resolveProjectKey(key: string): ProjectRef {
        const project = this.registry.projects[key];
        if (project === undefined) {
            const known = Object.keys(this.registry.projects).join(", ");
            throw new Error(`plane: unknown project key "${key}" (known: ${known})`);
        }
        if (project.plane_project_id === undefined) {
            throw new Error(`plane: project "${key}" has no plane_project_id in config`);
        }
        return { key, projectId: project.plane_project_id };
    }

    private resolveIssueKey(issueKey: string): ProjectRef {
        const dash = issueKey.lastIndexOf("-");
        if (dash === -1) {
            throw new Error(`plane: malformed issue key "${issueKey}"`);
        }
        return this.resolveProjectKey(issueKey.slice(0, dash));
    }

    private async loadCaches(ref: ProjectRef): Promise<ProjectCaches> {
        const cached = this.caches.get(ref.projectId);
        if (cached) {
            return cached;
        }

        const [states, labels, modules, types] = await Promise.all([
            this.client.listStates(ref.projectId),
            this.client.listLabels(ref.projectId),
            this.client.listModules(ref.projectId),
            this.client.listTypes(ref.projectId),
        ]);

        const caches: ProjectCaches = {
            labelsById: new Map(labels.map((l) => [l.id, l])),
            labelsByName: new Map(labels.map((l) => [l.name, l])),
            modulesById: new Map(modules.map((m) => [m.id, m])),
            statesById: new Map(states.map((s) => [s.id, s])),
            statesByName: new Map(states.map((s) => [s.name, s])),
            typesById: new Map(types.map((tp) => [tp.id, tp])),
            typesByName: new Map(types.map((tp) => [tp.name, tp])),
        };
        this.caches.set(ref.projectId, caches);
        return caches;
    }

    private mapContext(ref: ProjectRef, caches: ProjectCaches): MapContext {
        return {
            identifier: ref.key,
            labelsById: caches.labelsById,
            modulesById: caches.modulesById,
            statesById: caches.statesById,
            typesById: caches.typesById,
        };
    }

    public async getIssue(key: string): Promise<Issue> {
        const ref = this.resolveIssueKey(key);
        const caches = await this.loadCaches(ref);
        let raw;
        try {
            raw = await this.client.getWorkItemByIdentifier(key);
        } catch (err) {
            // 404/410 are DEFINITIVE: the work item was deleted. Any other status
            // (auth, 5xx, rate-limit) is transient and must keep its original error
            // so callers can retry rather than park.
            if (err instanceof PlaneHttpError && (err.status === 404 || err.status === 410)) {
                throw new IssueNotFoundError(key);
            }
            throw err;
        }
        return mapWorkItem(raw, this.mapContext(ref, caches));
    }

    public async blockedBy(issue: Issue): Promise<BlockerRef[]> {
        const ref = this.resolveIssueKey(issue.key);
        const caches = await this.loadCaches(ref);
        const relations = await this.client.listRelations(ref.projectId, issue.id);
        const blockerIds = relations.blocked_by ?? [];
        const ctx = this.mapContext(ref, caches);

        const refs: BlockerRef[] = [];
        for (const blockerId of blockerIds) {
            // The relations payload carries only UUIDs, so fetch each blocker to learn
            // Its sequence id (for the key) and state group (for `done`). A failed
            // Fetch propagates — never collapse a missing blocker into a false "done".
            const raw = await this.client.getWorkItem(ref.projectId, blockerId);
            const blocker = mapWorkItem(raw, ctx);
            refs.push({
                done: blocker.state.group === "completed" || blocker.state.group === "cancelled",
                key: blocker.key,
            });
        }
        return refs;
    }

    // Degrade-safe: any fetch failure (404/unexpected) collapses to []. Name comes
    // From the top-level field or the legacy `attributes.name`; the download URL is a
    // Separate Plane call, so it's often absent — we still surface a NAMED attachment
    // (without a URL) so the tracker-blind agent at least knows it exists. Only a
    // Nameless entry is dropped.
    private async fetchAttachments(projectId: string, id: string): Promise<Attachment[]> {
        try {
            const raws = await this.client.listAttachments(projectId, id);
            return raws
                .map((a) => ({ name: a.name ?? a.attributes?.name ?? "", url: a.asset_url ?? "" }))
                .filter((a) => a.name !== "");
        } catch {
            return [];
        }
    }

    // Degrade-safe: a failed parent fetch just omits the parent context.
    private async fetchParent(
        projectId: string,
        parentId: string,
        ctx: MapContext,
    ): Promise<ParentContext | undefined> {
        try {
            const raw = await this.client.getWorkItem(projectId, parentId);
            const p = mapWorkItem(raw, ctx);
            return { body: p.body, key: p.key, title: p.title, type: p.type };
        } catch {
            return undefined;
        }
    }

    public async issueContext(issue: Issue): Promise<IssueContext> {
        const ref = this.resolveIssueKey(issue.key);
        const caches = await this.loadCaches(ref);
        const ctx = this.mapContext(ref, caches);

        const attachments = await this.fetchAttachments(ref.projectId, issue.id);
        const parent =
            issue.parentId !== undefined ? await this.fetchParent(ref.projectId, issue.parentId, ctx) : undefined;

        return { attachments, ...(parent !== undefined ? { parent } : {}) };
    }

    public async createIssue(project: string, draft: IssueDraft): Promise<Issue> {
        const ref = this.resolveProjectKey(project);
        const caches = await this.loadCaches(ref);

        const body: Record<string, unknown> = {
            description_html: draft.body,
            name: draft.title,
        };

        if (draft.type !== undefined) {
            const type = caches.typesByName.get(draft.type);
            if (type === undefined) {
                const known = [...caches.typesByName.keys()].join(", ");
                throw new Error(
                    `plane: unknown work-item type "${draft.type}" in project ${ref.key} (known: ${known})`,
                );
            }
            body.type_id = type.id;
        }

        if (draft.priority !== undefined) {
            body.priority = draft.priority;
        }

        if (draft.labels !== undefined && draft.labels.length > 0) {
            const labelIds: string[] = [];
            for (const name of draft.labels) {
                const label = caches.labelsByName.get(name);
                if (label === undefined) {
                    const known = [...caches.labelsByName.keys()].join(", ");
                    throw new Error(`plane: unknown label name "${name}" in project ${ref.key} (known: ${known})`);
                }
                labelIds.push(label.id);
            }
            body.labels = labelIds;
        }

        if (draft.state !== undefined) {
            const state = caches.statesByName.get(draft.state);
            if (state === undefined) {
                const known = [...caches.statesByName.keys()].join(", ");
                throw new Error(`plane: unknown state name "${draft.state}" in project ${ref.key} (known: ${known})`);
            }
            body.state = state.id;
        }

        if (draft.assigneeId !== undefined) {
            body.assignees = [draft.assigneeId];
        }

        const created = await this.client.createWorkItem(ref.projectId, body);
        // The POST response may be unexpanded; re-fetch expanded so the returned
        // Issue carries fully-populated state/labels/type.
        const raw = await this.client.getWorkItem(ref.projectId, created.id);
        return mapWorkItem(raw, this.mapContext(ref, caches));
    }

    public async listQueue(filter: QueueFilter): Promise<Issue[]> {
        const ref = this.resolveProjectKey(filter.project);
        const caches = await this.loadCaches(ref);
        const raws = await this.client.listWorkItems(ref.projectId);
        const ctx = this.mapContext(ref, caches);
        let issues = raws.map((raw) => mapWorkItem(raw, ctx));

        if (filter.state !== undefined) {
            issues = issues.filter((i) => i.state.name === filter.state);
        } else if (filter.stateGroup !== undefined) {
            issues = issues.filter((i) => i.state.group === filter.stateGroup);
        }

        return issues
            .map((issue, index) => ({ index, issue }))
            .sort((a, b) => {
                const byRank = priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
                return byRank !== 0 ? byRank : a.index - b.index;
            })
            .map((entry) => entry.issue);
    }

    // Cycle-aware scheduling (opt-in). DEGRADE-SAFE: the cycles endpoints are
    // UNVERIFIED, so any failure — no active cycle, unsupported, or a fetch error —
    // Collapses to null, which the watch loop reads as "dispatch without a cycle filter".
    public async activeCycleIssueIds(project: string): Promise<Set<string> | null> {
        const ref = this.resolveProjectKey(project);
        try {
            const cycles = await this.client.listCycles(ref.projectId);
            const today = new Date().toISOString().slice(0, 10);
            const active = pickActiveCycle(cycles, today);
            if (active === null) {
                return null;
            }
            const items = await this.client.listCycleWorkItems(ref.projectId, active.id);
            const ids = new Set<string>();
            for (const it of items) {
                const id = it.work_item ?? it.id;
                if (id !== undefined) {
                    ids.add(id);
                }
            }
            return ids;
        } catch {
            return null;
        }
    }

    public async updateState(issue: Issue, stateName: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        const caches = await this.loadCaches(ref);
        const state = caches.statesByName.get(stateName);
        if (state === undefined) {
            const known = [...caches.statesByName.keys()].join(", ");
            throw new Error(`plane: unknown state name "${stateName}" in project ${ref.key} (known: ${known})`);
        }
        await this.client.patchWorkItem(ref.projectId, issue.id, {
            state: state.id,
        });
    }

    public async assign(issue: Issue, assigneeId: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        await this.client.patchWorkItem(ref.projectId, issue.id, {
            assignees: [assigneeId],
        });
    }

    public async addProperty(issue: Issue, name: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        const caches = await this.loadCaches(ref);
        const target = caches.labelsByName.get(name);
        if (target === undefined) {
            const known = [...caches.labelsByName.keys()].join(", ");
            throw new Error(`plane: unknown label name "${name}" in project ${ref.key} (known: ${known})`);
        }

        const uuids = new Set<string>();
        for (const labelName of issue.labels) {
            const existing = caches.labelsByName.get(labelName);
            if (existing !== undefined) {
                uuids.add(existing.id);
            }
        }
        uuids.add(target.id);

        await this.client.patchWorkItem(ref.projectId, issue.id, {
            labels: [...uuids],
        });
    }

    public async removeProperty(issue: Issue, name: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        const caches = await this.loadCaches(ref);
        const target = caches.labelsByName.get(name);
        if (target === undefined || !issue.labels.includes(name)) {
            return;
        }

        const uuids = new Set<string>();
        for (const labelName of issue.labels) {
            const existing = caches.labelsByName.get(labelName);
            if (existing !== undefined) {
                uuids.add(existing.id);
            }
        }
        uuids.delete(target.id);

        await this.client.patchWorkItem(ref.projectId, issue.id, {
            labels: [...uuids],
        });
    }

    public async createProperty(
        project: string,
        name: string,
        opts?: { color?: string; description?: string },
    ): Promise<void> {
        const ref = this.resolveProjectKey(project);
        const labels = await this.client.listLabels(ref.projectId);
        if (labels.some((l) => l.name === name)) {
            return;
        }
        await this.client.createLabel(ref.projectId, {
            color: opts?.color,
            description: opts?.description,
            name,
        });
    }

    public async deleteProperty(project: string, name: string): Promise<void> {
        const ref = this.resolveProjectKey(project);
        const labels = await this.client.listLabels(ref.projectId);
        const label = labels.find((l) => l.name === name);
        if (label === undefined) {
            return;
        }
        await this.client.deleteLabel(ref.projectId, label.id);
    }

    public async comment(issue: Issue, body: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        const html = toCommentHtml(withMarker(body));
        // Idempotent: writeback is replayed on a resumed run, so don't post the
        // Same comment twice.
        const existing = await this.client.listComments(ref.projectId, issue.id);
        if (existing.some((c) => c.comment_html === html)) {
            return;
        }
        await this.client.createComment(ref.projectId, issue.id, {
            comment_html: html,
        });
    }

    public async listComments(issue: Issue): Promise<Comment[]> {
        const ref = this.resolveIssueKey(issue.key);
        const raws = await this.client.listComments(ref.projectId, issue.id);
        return raws
            .map((raw) => {
                const source = raw.comment_html ?? raw.comment_stripped ?? "";
                const textBody = raw.comment_stripped ?? unescapeHtml(source.replace(/<[^>]*>/g, ""));
                return {
                    authorId: raw.created_by,
                    body: stripMarker(textBody),
                    createdAt: raw.created_at ?? "",
                    id: raw.id,
                    isBot: hasMarker(source),
                };
            })
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    public async linkPR(issue: Issue, url: string, title?: string): Promise<void> {
        const ref = this.resolveIssueKey(issue.key);
        // Idempotent: Plane rejects a duplicate link URL with a 400, and writeback
        // Is replayed on a resumed run, so skip if this URL is already linked.
        const existing = await this.client.listLinks(ref.projectId, issue.id);
        if (existing.some((link) => link.url === url)) {
            return;
        }
        await this.client.createLink(ref.projectId, issue.id, {
            title: title ?? "Pull Request",
            url,
        });
    }

    public readMetadata(issue: Issue): IssueMeta {
        return parseIssueMeta(issue.body, issue.labels);
    }

    public async listInbox(project: string): Promise<IntakeItem[]> {
        const ref = this.resolveProjectKey(project);
        const raws = await this.client.listIntake(ref.projectId);
        return raws.map(mapIntakeItem);
    }

    public async acceptInbox(project: string, item: IntakeItem): Promise<void> {
        const ref = this.resolveProjectKey(project);
        await this.client.updateIntakeStatus(ref.projectId, item.issueId, 1);
    }

    public async inspectBoard(project: string): Promise<BoardState> {
        const ref = this.resolveProjectKey(project);
        const [states, labels, modules, types] = await Promise.all([
            this.client.listStates(ref.projectId),
            this.client.listLabels(ref.projectId),
            this.client.listModules(ref.projectId),
            this.client.listTypes(ref.projectId).catch(() => []),
        ]);
        return {
            labels: labels.map((l) => l.name),
            modules: modules.map((m) => m.name),
            states: states.map((s) => s.name),
            types: types.map((t) => t.name),
        };
    }

    public async ensureBoard(
        project: string,
        template: BoardTemplate,
        opts?: EnsureBoardOptions,
    ): Promise<EnsureBoardResult> {
        const ref = this.resolveProjectKey(project);
        const result: EnsureBoardResult = {
            created: [],
            orphans: [],
            pruned: [],
            skipped: [],
            updated: [],
            warnings: [],
        };

        await this.ensureFeatures(ref.projectId);

        const [states, labels, modules] = await Promise.all([
            this.client.listStates(ref.projectId),
            this.client.listLabels(ref.projectId),
            this.client.listModules(ref.projectId),
        ]);

        const statesByName = new Map(states.map((s) => [s.name, s]));
        for (const state of template.states) {
            const existing = statesByName.get(state.name);
            if (existing === undefined) {
                await this.client.createState(ref.projectId, {
                    color: state.color,
                    group: state.group,
                    name: state.name,
                    sequence: state.sequence,
                });
                result.created.push(`state:${state.name}`);
                continue;
            }
            const drift: Record<string, unknown> = {};
            if (existing.color !== state.color) {
                drift.color = state.color;
            }
            if (existing.group !== state.group) {
                drift.group = state.group;
            }
            if (state.sequence !== undefined && existing.sequence !== state.sequence) {
                drift.sequence = state.sequence;
            }
            await this.reconcile("state", state.name, existing.id, drift, result, async (id, body) =>
                this.client.updateState(ref.projectId, id, body),
            );
        }

        const labelsByName = new Map(labels.map((l) => [l.name, l]));
        for (const label of template.labels) {
            const existing = labelsByName.get(label.name);
            if (existing === undefined) {
                await this.client.createLabel(ref.projectId, {
                    color: label.color,
                    description: label.description,
                    name: label.name,
                });
                result.created.push(`label:${label.name}`);
                continue;
            }
            const drift: Record<string, unknown> = {};
            if (label.color !== undefined && existing.color !== label.color) {
                drift.color = label.color;
            }
            if (label.description !== undefined && existing.description !== label.description) {
                drift.description = label.description;
            }
            await this.reconcile("label", label.name, existing.id, drift, result, async (id, body) =>
                this.client.updateLabel(ref.projectId, id, body),
            );
        }

        const modulesByName = new Map(modules.map((m) => [m.name, m]));
        const templateModuleNames = new Set(template.modules.map((m) => m.name));

        // Reconcile description drift for modules already present by name.
        for (const mod of template.modules) {
            const existing = modulesByName.get(mod.name);
            if (existing === undefined) {
                continue;
            }
            const drift: Record<string, unknown> = {};
            if (mod.description !== undefined && existing.description !== mod.description) {
                drift.description = mod.description;
            }
            await this.reconcile("module", mod.name, existing.id, drift, result, async (id, body) =>
                this.client.updateModule(ref.projectId, id, body),
            );
        }

        const added = template.modules.filter((m) => !modulesByName.has(m.name));
        const removed = modules.filter((m) => !templateModuleNames.has(m.name));

        // Only an ambiguous shape (both an addition and a removal) needs a human decision.
        const decisions: Record<string, ModuleChangeAction> =
            added.length > 0 && removed.length > 0 && opts?.resolveModuleChanges !== undefined
                ? await opts.resolveModuleChanges({
                      added: added.map((m) => m.name),
                      removed: removed.map((m) => m.name),
                  })
                : {};

        const renamedTo = new Set<string>();
        for (const orphan of removed) {
            const decision = decisions[orphan.name];
            if (decision?.kind === "rename") {
                await this.client.updateModule(ref.projectId, orphan.id, { name: decision.to });
                result.updated.push(`module:${orphan.name}→${decision.to}`);
                renamedTo.add(decision.to);
                continue;
            }
            if (decision?.kind === "remove") {
                try {
                    await this.client.deleteModule(ref.projectId, orphan.id);
                    result.pruned.push(`module:${orphan.name}`);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    result.warnings.push(`remove module:${orphan.name} failed: ${reason}`);
                }
                continue;
            }
            // "keep", or no decision (non-interactive): record orphan; delete only if prune.
            await this.handleOrphan("module", orphan.name, opts, result, async () =>
                this.client.deleteModule(ref.projectId, orphan.id),
            );
        }

        // Create template modules that are neither already present nor satisfied by a rename.
        for (const mod of added) {
            if (renamedTo.has(mod.name)) {
                continue;
            }
            await this.client.createModule(ref.projectId, { description: mod.description, name: mod.name });
            result.created.push(`module:${mod.name}`);
        }

        const templateLabelNames = new Set(template.labels.map((l) => l.name));
        for (const label of labels) {
            if (!label.name.startsWith("agent:")) {
                continue;
            }
            if (templateLabelNames.has(label.name)) {
                continue;
            }
            await this.handleOrphan("label", label.name, opts, result, async () =>
                this.client.deleteLabel(ref.projectId, label.id),
            );
        }

        await this.ensureTypes(ref.projectId, template, result);

        return result;
    }

    // Record an orphan (candidate not in the template). When prune is on, delete
    // It and record it as pruned; a failed delete is a warning, not fatal.
    private async handleOrphan(
        kind: string,
        name: string,
        opts: EnsureBoardOptions | undefined,
        result: EnsureBoardResult,
        del: () => Promise<unknown>,
    ): Promise<void> {
        result.orphans.push(`${kind}:${name}`);
        if (opts?.prune !== true) {
            return;
        }
        try {
            await del();
            result.pruned.push(`${kind}:${name}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.warnings.push(`prune ${kind}:${name} failed: ${reason}`);
        }
    }

    // Skip when nothing drifted; otherwise PATCH the changed fields. A failed
    // Update is recorded as a warning and must not abort the rest of the run.
    private async reconcile(
        kind: string,
        name: string,
        id: string,
        drift: Record<string, unknown>,
        result: EnsureBoardResult,
        patch: (id: string, body: Record<string, unknown>) => Promise<unknown>,
    ): Promise<void> {
        if (Object.keys(drift).length === 0) {
            result.skipped.push(`${kind}:${name}`);
            return;
        }
        try {
            await patch(id, drift);
            result.updated.push(`${kind}:${name}`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            result.warnings.push(`update ${kind}:${name} failed: ${reason}`);
        }
    }

    private async ensureFeatures(projectId: string): Promise<void> {
        await this.client.updateProjectFeatures(projectId, {
            intake_view: true,
            is_issue_type_enabled: true,
            module_view: true,
        });
    }

    private async ensureTypes(projectId: string, template: BoardTemplate, result: EnsureBoardResult): Promise<void> {
        if (template.types.length === 0) {
            return;
        }

        let existingByName: Map<string, RawWorkItemType>;
        try {
            const types = await this.client.listTypes(projectId);
            existingByName = new Map(types.map((t) => [t.name, t]));
        } catch (error) {
            result.warnings.push(this.typesFeatureWarning(error));
            return;
        }

        for (const type of template.types) {
            const existing = existingByName.get(type.name);
            if (existing === undefined) {
                try {
                    await this.client.createType(projectId, {
                        description: type.description,
                        name: type.name,
                    });
                    result.created.push(`type:${type.name}`);
                } catch (error) {
                    result.warnings.push(this.typesFeatureWarning(error));
                    return;
                }
                continue;
            }
            const drift: Record<string, unknown> = {};
            if (type.description !== undefined && existing.description !== type.description) {
                drift.description = type.description;
            }
            await this.reconcile("type", type.name, existing.id, drift, result, async (id, body) =>
                this.client.updateType(projectId, id, body),
            );
        }
    }

    public async verifyAuth(): Promise<void> {
        verifyPlaneConfig(this.auth);
        try {
            await this.client.getMe();
        } catch (err) {
            if (err instanceof PlaneHttpError && (err.status === 401 || err.status === 403)) {
                throw new Error(
                    `beflow: Plane token invalid for workspace "${this.auth.workspaceSlug}" — check ${this.auth.apiKeyEnv} and workspaceSlug in ${configPath()}`,
                );
            }
            throw err;
        }
    }

    public async createProject(spec: ProjectCreateSpec): Promise<ProjectCreateResult> {
        const created = await this.client.createProject({ identifier: spec.identifier, name: spec.name });
        return { trackerProjectId: created.id };
    }

    public async findProjectId(identifier: string): Promise<string | null> {
        const wanted = identifier.toUpperCase();
        const projects = await this.client.listProjects();
        const match = projects.find((p) => (p.identifier ?? "").toUpperCase() === wanted);
        return match?.id ?? null;
    }

    private typesFeatureWarning(error: unknown): string {
        const reason = error instanceof Error ? error.message : String(error);
        return `plane: could not create work-item types (${reason}). Enable Workspace Settings → Features → Work Item Types, then re-run ensureBoard.`;
    }
}

// Static, network-free validation of the Plane config block: catches a config
// that is structurally present but not yet usable (the bootstrap placeholder).
// Shared by verifyAuth (so setup fails fast) and doctor (so a plain run reports it).
export function verifyPlaneConfig(auth: { workspaceSlug: string; apiKeyEnv: string }): void {
    if (auth.workspaceSlug === "your-workspace") {
        throw new Error(
            `beflow: Plane workspace is still the placeholder "your-workspace" — edit workspaceSlug + workspace in ${configPath()} and set ${auth.apiKeyEnv}, then re-run`,
        );
    }
}

export function createPlaneTracker(
    config: Config,
    registry: Registry,
    env: NodeJS.ProcessEnv = process.env,
): PlaneTracker {
    const planeConfig = config.trackers.plane;
    if (planeConfig === undefined) {
        throw new Error("plane: config.trackers.plane is not configured");
    }

    const apiKey = env[planeConfig.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
        throw new Error(`plane: API key env var "${planeConfig.apiKeyEnv}" is unset`);
    }

    const client = new PlaneClient({
        apiKey,
        baseUrl: planeConfig.baseUrl,
        workspaceSlug: planeConfig.workspaceSlug,
    });

    return new PlaneTracker({
        auth: { apiKeyEnv: planeConfig.apiKeyEnv, workspaceSlug: planeConfig.workspaceSlug },
        client,
        registry,
    });
}
