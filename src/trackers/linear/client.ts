import type { LinearClient } from "@linear/sdk";

import type { RawAttachment, RawBlocker, RawComment, RawIssue, RawLabel, RawWorkflowState } from "./types.ts";

export interface ListIssuesQuery {
    stateName?: string;
    stateType?: string;
}

export interface CreateIssueInput {
    title: string;
    description: string;
    priority?: number;
    labelIds?: string[];
    stateId?: string;
    assigneeId?: string;
}

// The narrow async surface the adapter depends on. The SDK lives ONLY behind
// LinearSdkGateway; the adapter + mappers depend on this interface so tests
// Can supply a fake without touching @linear/sdk or the network.
export interface LinearGateway {
    verifyAuth(): Promise<void>; // cheap authenticated probe; rejects when the token is invalid
    getIssueByIdentifier(identifier: string): Promise<RawIssue>;
    getBlockers(issueId: string): Promise<RawBlocker[]>;
    createIssue(teamKey: string, input: CreateIssueInput): Promise<RawIssue>;
    listIssues(teamKey: string, query?: ListIssuesQuery): Promise<RawIssue[]>;
    listTriage(teamKey: string): Promise<RawIssue[]>;
    updateIssueState(issueId: string, stateId: string): Promise<void>;
    updateIssueAssignee(issueId: string, assigneeId: string): Promise<void>;
    updateIssueLabels(issueId: string, labelIds: string[]): Promise<void>;
    createComment(issueId: string, body: string): Promise<void>;
    listComments(issueId: string): Promise<RawComment[]>;
    createAttachment(issueId: string, url: string, title: string): Promise<void>;
    listAttachments(issueId: string): Promise<RawAttachment[]>;
    listStates(teamKey: string): Promise<RawWorkflowState[]>;
    listLabels(teamKey: string): Promise<RawLabel[]>;
    createState(teamKey: string, state: { name: string; type: StateGroupLike; color: string }): Promise<void>;
    createLabel(teamKey: string, label: { name: string; color?: string }): Promise<void>;
    createTeam(input: { key: string; name: string }): Promise<{ id: string }>;
    findTeamId(key: string): Promise<string | null>; // the Linear team id for this key, or null when no such team exists
    deleteLabel(labelId: string): Promise<void>;
}

// beflow's spelling for the cancelled state group. The Linear SDK uses the American
// spelling "canceled" (one L); fromLinearStateType / toLinearStateType normalize at
// the gateway boundary so all other code always sees "cancelled".
export type StateGroupLike = "backlog" | "unstarted" | "started" | "completed" | "cancelled" | "triage";

export function fromLinearStateType(type: string): string {
    return type === "canceled" ? "cancelled" : type;
}

export function toLinearStateType(type: string): string {
    return type === "cancelled" ? "canceled" : type;
}

// The SDK Issue type as returned by client.issue() / client.issues().nodes.
// resolveIssue depends only on the structural subset declared below; deriving
// the type from the SDK avoids an unsafe narrowing cast.
type SdkIssueSource = Awaited<ReturnType<LinearClient["issue"]>>;

// The structural subset of an SDK paginated connection the gateway relies on to
// walk every page. The SDK's default page is ~50, so reading only the first page
// silently truncates larger teams/issues.
export interface SdkConnection<T> {
    nodes: T[];
    pageInfo: { hasNextPage: boolean };
    fetchNext(): Promise<SdkConnection<T>>;
}

export async function collectNodes<T>(first: SdkConnection<T>): Promise<T[]> {
    const nodes: T[] = [];
    let connection = first;
    for (;;) {
        nodes.push(...connection.nodes);
        if (!connection.pageInfo.hasNextPage) {
            break;
        }
        connection = await connection.fetchNext();
    }
    return nodes;
}

const DEFAULT_STATE_COLOR = "#95a2b3";
const DEFAULT_LABEL_COLOR = "#bec2c8";

export class LinearSdkGateway implements LinearGateway {
    private readonly client: LinearClient;
    private readonly teamIdByKey = new Map<string, string>();

    public constructor(client: LinearClient) {
        this.client = client;
    }

    private async resolveIssue(issue: SdkIssueSource): Promise<RawIssue> {
        const [state, labelConn, team] = await Promise.all([issue.state, issue.labels(), issue.team]);
        if (state === undefined) {
            throw new Error(`linear: issue ${issue.identifier} has no state`);
        }
        if (team === undefined) {
            throw new Error(`linear: issue ${issue.identifier} has no team`);
        }
        return {
            archivedAt: issue.archivedAt?.toISOString() ?? null,
            description: issue.description ?? undefined,
            id: issue.id,
            identifier: issue.identifier,
            labels: labelConn.nodes.map((l) => ({ id: l.id, name: l.name })),
            priority: issue.priority,
            state: { id: state.id, name: state.name, type: fromLinearStateType(state.type) },
            team: { id: team.id, key: team.key },
            title: issue.title,
        };
    }

    private async teamId(teamKey: string): Promise<string> {
        const cached = this.teamIdByKey.get(teamKey);
        if (cached !== undefined) {
            return cached;
        }
        const conn = await this.client.teams({
            filter: { key: { eq: teamKey } },
        });
        const team = conn.nodes[0];
        if (team === undefined) {
            throw new Error(`linear: unknown team key "${teamKey}"`);
        }
        this.teamIdByKey.set(teamKey, team.id);
        return team.id;
    }

    public async verifyAuth(): Promise<void> {
        await this.client.viewer;
    }

    public async getIssueByIdentifier(identifier: string): Promise<RawIssue> {
        const issue = await this.client.issue(identifier);
        return this.resolveIssue(issue);
    }

    // The issues that BLOCK this one. An inverseRelation of type "blocks" has its
    // SOURCE issue (node.issue) as the blocker; node.relatedIssue is this issue.
    public async getBlockers(issueId: string): Promise<RawBlocker[]> {
        const issue = await this.client.issue(issueId);
        const relations = await collectNodes(await issue.inverseRelations());
        const blockers: RawBlocker[] = [];
        for (const node of relations) {
            if (node.type !== "blocks") {
                continue;
            }
            const src = await node.issue;
            if (src === undefined) {
                continue;
            }
            const st = await src.state;
            blockers.push({ identifier: src.identifier, stateType: fromLinearStateType(st?.type ?? "") });
        }
        return blockers;
    }

    public async createIssue(teamKey: string, input: CreateIssueInput): Promise<RawIssue> {
        const payload = await this.client.createIssue({
            assigneeId: input.assigneeId,
            description: input.description,
            labelIds: input.labelIds,
            priority: input.priority,
            stateId: input.stateId,
            teamId: await this.teamId(teamKey),
            title: input.title,
        });
        const issue = await payload.issue;
        if (issue === undefined) {
            throw new Error(`linear: createIssue for team ${teamKey} returned no issue`);
        }
        return this.resolveIssue(issue);
    }

    public async listIssues(teamKey: string, query: ListIssuesQuery = {}): Promise<RawIssue[]> {
        const filter: Record<string, unknown> = { team: { key: { eq: teamKey } } };
        if (query.stateName !== undefined) {
            filter.state = { name: { eq: query.stateName } };
        } else if (query.stateType !== undefined) {
            filter.state = { type: { eq: toLinearStateType(query.stateType) } };
        }
        return this.fetchIssues(filter);
    }

    public async listTriage(teamKey: string): Promise<RawIssue[]> {
        return this.fetchIssues({
            state: { type: { eq: "triage" } },
            team: { key: { eq: teamKey } },
        });
    }

    private async fetchIssues(filter: Record<string, unknown>): Promise<RawIssue[]> {
        const results: RawIssue[] = [];
        let connection = await this.client.issues({ filter, first: 100 });
        for (;;) {
            for (const node of connection.nodes) {
                results.push(await this.resolveIssue(node));
            }
            if (!connection.pageInfo.hasNextPage) {
                break;
            }
            connection = await connection.fetchNext();
        }
        return results;
    }

    public async updateIssueState(issueId: string, stateId: string): Promise<void> {
        await this.client.updateIssue(issueId, { stateId });
    }

    public async updateIssueAssignee(issueId: string, assigneeId: string): Promise<void> {
        await this.client.updateIssue(issueId, { assigneeId });
    }

    public async updateIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
        await this.client.updateIssue(issueId, { labelIds });
    }

    public async createComment(issueId: string, body: string): Promise<void> {
        await this.client.createComment({ body, issueId });
    }

    public async listComments(issueId: string): Promise<RawComment[]> {
        const issue = await this.client.issue(issueId);
        const nodes = await collectNodes(await issue.comments());
        const comments: RawComment[] = [];
        for (const node of nodes) {
            const user = await node.user;
            comments.push({
                ...(user?.id !== undefined ? { authorId: user.id } : {}),
                body: node.body,
                createdAt: node.createdAt.toISOString(),
                id: node.id,
            });
        }
        return comments;
    }

    public async createAttachment(issueId: string, url: string, title: string): Promise<void> {
        await this.client.createAttachment({ issueId, title, url });
    }

    public async listAttachments(issueId: string): Promise<RawAttachment[]> {
        const issue = await this.client.issue(issueId);
        const nodes = await collectNodes(await issue.attachments());
        return nodes.map((a) => ({ id: a.id, title: a.title, url: a.url }));
    }

    public async listStates(teamKey: string): Promise<RawWorkflowState[]> {
        const team = await this.client.team(await this.teamId(teamKey));
        const nodes = await collectNodes(await team.states());
        return nodes.map((s) => ({ id: s.id, name: s.name, type: fromLinearStateType(s.type) }));
    }

    public async listLabels(teamKey: string): Promise<RawLabel[]> {
        const team = await this.client.team(await this.teamId(teamKey));
        const nodes = await collectNodes(await team.labels());
        return nodes.map((l) => ({ id: l.id, name: l.name }));
    }

    public async createState(
        teamKey: string,
        state: { name: string; type: StateGroupLike; color: string },
    ): Promise<void> {
        await this.client.createWorkflowState({
            color: state.color,
            name: state.name,
            teamId: await this.teamId(teamKey),
            type: toLinearStateType(state.type),
        });
    }

    public async createLabel(teamKey: string, label: { name: string; color?: string }): Promise<void> {
        await this.client.createIssueLabel({
            color: label.color ?? DEFAULT_LABEL_COLOR,
            name: label.name,
            teamId: await this.teamId(teamKey),
        });
    }

    public async deleteLabel(labelId: string): Promise<void> {
        await this.client.deleteIssueLabel(labelId);
    }

    public async createTeam(input: { key: string; name: string }): Promise<{ id: string }> {
        const payload = await this.client.createTeam({ key: input.key, name: input.name });
        const team = await payload.team;
        if (team === undefined) {
            throw new Error(`linear: createTeam "${input.name}" returned no team`);
        }
        return { id: team.id };
    }

    public async findTeamId(key: string): Promise<string | null> {
        const conn = await this.client.teams({ filter: { key: { eq: key } } });
        return conn.nodes[0]?.id ?? null;
    }
}

export { DEFAULT_STATE_COLOR, DEFAULT_LABEL_COLOR };
