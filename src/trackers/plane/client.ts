import type {
    Paginated,
    RawAttachment,
    RawComment,
    RawCycle,
    RawCycleWorkItem,
    RawIntakeIssue,
    RawLabel,
    RawLink,
    RawModule,
    RawProject,
    RawState,
    RawWorkItem,
    RawUser,
    RawWorkItemRelations,
    RawWorkItemType,
} from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PlaneHttpError extends Error {
    public constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "PlaneHttpError";
    }
}

export interface PlaneClientOptions {
    baseUrl?: string;
    workspaceSlug: string;
    apiKey: string;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
}

interface ListWorkItemsOptions {
    expand?: string;
    order_by?: string;
}

const MAX_RETRIES = 2;
const DEFAULT_BASE_URL = "https://api.plane.so";

async function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Deserialization trust boundary: the caller declares the response shape T.
function hasShape<T>(_value: unknown): _value is T {
    return true;
}

function decodeBody<T>(value: unknown): T {
    if (!hasShape<T>(value)) {
        throw new Error("plane: response body did not match expected shape");
    }
    return value;
}

export class PlaneClient {
    private readonly baseUrl: string;
    private readonly slug: string;
    private readonly apiKey: string;
    private readonly fetch: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;

    public constructor(options: PlaneClientOptions) {
        this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.slug = options.workspaceSlug;
        this.apiKey = options.apiKey;
        this.fetch = options.fetch ?? (globalThis.fetch as FetchLike);
        this.sleep = options.sleep ?? realSleep;
    }

    private headers(): Record<string, string> {
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-API-Key": this.apiKey,
        };
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const init: RequestInit = { headers: this.headers(), method };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }

        let attempt = 0;
        for (;;) {
            const response = await this.fetch(url, init);

            if (response.status === 429 && attempt < MAX_RETRIES) {
                const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
                const seconds = Number.isFinite(retryAfter) ? retryAfter : 1;
                await this.sleep(seconds * 1000);
                attempt += 1;
                continue;
            }

            if (!response.ok) {
                const snippet = (await response.text()).slice(0, 500);
                throw new PlaneHttpError(
                    response.status,
                    `plane: ${method} ${path} failed with ${String(response.status)}: ${snippet}`,
                );
            }

            if (response.status === 204) {
                return decodeBody<T>(undefined);
            }
            const text = await response.text();
            if (text === "") {
                return decodeBody<T>(undefined);
            }
            const parsed: unknown = JSON.parse(text);
            return decodeBody<T>(parsed);
        }
    }

    private projectBase(projectId: string): string {
        return `/api/v1/workspaces/${this.slug}/projects/${projectId}`;
    }

    private async paginate<T>(basePath: string): Promise<T[]> {
        const results: T[] = [];
        let cursor: string | undefined;
        for (;;) {
            const sep = basePath.includes("?") ? "&" : "?";
            const path =
                cursor === undefined
                    ? `${basePath}${sep}per_page=100`
                    : `${basePath}${sep}per_page=100&cursor=${encodeURIComponent(cursor)}`;
            const page = await this.request<Paginated<T>>("GET", path);
            results.push(...page.results);
            if (!page.next_page_results) {
                break;
            }
            cursor = page.next_cursor;
        }
        return results;
    }

    public async getMe(): Promise<RawUser> {
        return this.request<RawUser>("GET", "/api/v1/users/me/");
    }

    public async createProject(body: { identifier: string; name: string }): Promise<RawProject> {
        return this.request<RawProject>("POST", `/api/v1/workspaces/${this.slug}/projects/`, body);
    }

    public async getWorkItemByIdentifier(key: string): Promise<RawWorkItem> {
        const path = `/api/v1/workspaces/${this.slug}/work-items/${key}/?expand=state,labels`;
        return this.request<RawWorkItem>("GET", path);
    }

    public async listWorkItems(projectId: string, options: ListWorkItemsOptions = {}): Promise<RawWorkItem[]> {
        const expand = options.expand ?? "state,labels";
        const params = new URLSearchParams({ expand });
        if (options.order_by !== undefined && options.order_by !== "") {
            params.set("order_by", options.order_by);
        }
        const path = `${this.projectBase(projectId)}/work-items/?${params.toString()}`;
        return this.paginate<RawWorkItem>(path);
    }

    public async getWorkItem(projectId: string, id: string): Promise<RawWorkItem> {
        const path = `${this.projectBase(projectId)}/work-items/${id}/?expand=state,labels`;
        return this.request<RawWorkItem>("GET", path);
    }

    public async createWorkItem(projectId: string, body: unknown): Promise<RawWorkItem> {
        return this.request<RawWorkItem>("POST", `${this.projectBase(projectId)}/work-items/`, body);
    }

    public async patchWorkItem(projectId: string, id: string, body: unknown): Promise<RawWorkItem> {
        return this.request<RawWorkItem>("PATCH", `${this.projectBase(projectId)}/work-items/${id}/`, body);
    }

    // Relations are returned as a single grouped object (blocking, blocked_by, …),
    // each group a bare array of work-item UUIDs — NOT the paginated {results}
    // Envelope, so this must not paginate.
    public async listRelations(projectId: string, id: string): Promise<RawWorkItemRelations> {
        return this.request<RawWorkItemRelations>("GET", `${this.projectBase(projectId)}/work-items/${id}/relations/`);
    }

    public async createComment(projectId: string, id: string, body: { comment_html: string }): Promise<RawComment> {
        return this.request<RawComment>("POST", `${this.projectBase(projectId)}/work-items/${id}/comments/`, body);
    }

    public async listComments(projectId: string, id: string): Promise<RawComment[]> {
        return this.paginate<RawComment>(`${this.projectBase(projectId)}/work-items/${id}/comments/`);
    }

    public async createLink(projectId: string, id: string, body: { url: string; title?: string }): Promise<RawLink> {
        return this.request<RawLink>("POST", `${this.projectBase(projectId)}/work-items/${id}/links/`, body);
    }

    public async listLinks(projectId: string, id: string): Promise<RawLink[]> {
        return this.paginate<RawLink>(`${this.projectBase(projectId)}/work-items/${id}/links/`);
    }

    // UNVERIFIED endpoint shape — confirm during live dogfood. Returns the raw
    // Response as-is (NOT paginated); the adapter catches any failure and fails closed.
    public async listAttachments(projectId: string, id: string): Promise<RawAttachment[]> {
        return this.request<RawAttachment[]>("GET", `${this.projectBase(projectId)}/work-items/${id}/attachments/`);
    }

    // UNVERIFIED endpoint shape — confirm during live dogfood. The adapter fails
    // Closed on any error (→ null → unfiltered dispatch), so a wrong shape can't halt.
    public async listCycles(projectId: string): Promise<RawCycle[]> {
        return this.paginate<RawCycle>(`${this.projectBase(projectId)}/cycles/`);
    }

    // VERIFIED live (2026-06-18): the membership endpoint is `cycle-issues/` (not
    // `cycle-work-items/`, which 404s); each result IS the full work item, so its `id` is
    // the work-item uuid (RawCycleWorkItem reads `work_item ?? id`). Fails closed via the adapter.
    public async listCycleWorkItems(projectId: string, cycleId: string): Promise<RawCycleWorkItem[]> {
        return this.paginate<RawCycleWorkItem>(`${this.projectBase(projectId)}/cycles/${cycleId}/cycle-issues/`);
    }

    public async listStates(projectId: string): Promise<RawState[]> {
        return this.paginate<RawState>(`${this.projectBase(projectId)}/states/`);
    }

    public async listLabels(projectId: string): Promise<RawLabel[]> {
        return this.paginate<RawLabel>(`${this.projectBase(projectId)}/labels/`);
    }

    public async listModules(projectId: string): Promise<RawModule[]> {
        return this.paginate<RawModule>(`${this.projectBase(projectId)}/modules/`);
    }

    public async listTypes(projectId: string): Promise<RawWorkItemType[]> {
        // The work-item-types endpoint returns a bare array, NOT the cursor-paginated
        // {results} envelope the other list endpoints use — so it must not paginate.
        return this.request<RawWorkItemType[]>("GET", `${this.projectBase(projectId)}/work-item-types/`);
    }

    public async createState(projectId: string, body: unknown): Promise<RawState> {
        return this.request<RawState>("POST", `${this.projectBase(projectId)}/states/`, body);
    }

    public async updateState(projectId: string, id: string, body: unknown): Promise<RawState> {
        return this.request<RawState>("PATCH", `${this.projectBase(projectId)}/states/${id}/`, body);
    }

    public async createLabel(projectId: string, body: unknown): Promise<RawLabel> {
        return this.request<RawLabel>("POST", `${this.projectBase(projectId)}/labels/`, body);
    }

    public async updateLabel(projectId: string, id: string, body: unknown): Promise<RawLabel> {
        return this.request<RawLabel>("PATCH", `${this.projectBase(projectId)}/labels/${id}/`, body);
    }

    public async createModule(projectId: string, body: unknown): Promise<RawModule> {
        return this.request<RawModule>("POST", `${this.projectBase(projectId)}/modules/`, body);
    }

    public async updateModule(projectId: string, id: string, body: unknown): Promise<RawModule> {
        return this.request<RawModule>("PATCH", `${this.projectBase(projectId)}/modules/${id}/`, body);
    }

    public async deleteModule(projectId: string, id: string): Promise<void> {
        return this.request<undefined>("DELETE", `${this.projectBase(projectId)}/modules/${id}/`);
    }

    public async deleteLabel(projectId: string, id: string): Promise<void> {
        return this.request<undefined>("DELETE", `${this.projectBase(projectId)}/labels/${id}/`);
    }

    public async createType(projectId: string, body: unknown): Promise<RawWorkItemType> {
        return this.request<RawWorkItemType>("POST", `${this.projectBase(projectId)}/work-item-types/`, body);
    }

    public async updateType(projectId: string, id: string, body: unknown): Promise<RawWorkItemType> {
        return this.request<RawWorkItemType>("PATCH", `${this.projectBase(projectId)}/work-item-types/${id}/`, body);
    }

    public async updateProjectFeatures(
        projectId: string,
        features: { is_issue_type_enabled: boolean; intake_view: boolean; module_view: boolean },
    ): Promise<void> {
        return this.request<undefined>("PATCH", `${this.projectBase(projectId)}/`, features);
    }

    public async listIntake(projectId: string): Promise<RawIntakeIssue[]> {
        return this.paginate<RawIntakeIssue>(`${this.projectBase(projectId)}/intake-issues/`);
    }

    // VERIFIED live (2026-06-18): status updates require the /status/ suffix and
    // must use the ISSUE id (item.issueId), NOT the intake record id (item.id).
    // Plain PATCH intake-issues/<id>/ rejects status with HTTP 400.
    public async updateIntakeStatus(projectId: string, issueId: string, status: number): Promise<RawIntakeIssue> {
        return this.request<RawIntakeIssue>(
            "PATCH",
            `${this.projectBase(projectId)}/intake-issues/${issueId}/status/`,
            { status },
        );
    }
}
