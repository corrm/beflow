export type NotifyFormat = "discord" | "generic" | "slack";

export type NotifyReason = "needs_input" | "blocked" | "failed" | "reminder" | "resolved";

function parseHost(url: string): string | null {
    try {
        const { host } = new URL(url);
        return host;
    } catch {
        return null;
    }
}

export function detectFormat(url: string): NotifyFormat {
    const host = parseHost(url);
    if (host === null) {
        return "generic";
    }
    if (host.includes("hooks.slack.com")) {
        return "slack";
    }
    if (host.includes("discord.com") || host.includes("discordapp.com")) {
        return "discord";
    }
    return "generic";
}

export interface NotifyEvent {
    detail?: string;
    key: string;
    reason: NotifyReason;
    title: string;
}

export interface Notifier {
    notify: (evt: NotifyEvent) => Promise<void>;
}

/** Minimal fetch signature used for injection / testing. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export const noopNotifier: Notifier = {
    notify: async (): Promise<void> => {
        /* No-op: notification disabled */
    },
};

export class WebhookNotifier implements Notifier {
    private readonly fetchImpl?: FetchFn;
    private readonly format: NotifyFormat;
    private readonly log: (m: string) => void;
    private readonly url: string;

    public constructor(opts: { fetchImpl?: FetchFn; format?: NotifyFormat; log?: (m: string) => void; url: string }) {
        this.fetchImpl = opts.fetchImpl;
        this.format = opts.format ?? detectFormat(opts.url);
        this.log =
            opts.log ??
            ((): void => {
                /* No-op */
            });
        this.url = opts.url;
    }

    private buildBody(evt: NotifyEvent, message: string): Record<string, unknown> {
        if (this.format === "slack") {
            return { text: message };
        }
        if (this.format === "discord") {
            const content = message.length > 2000 ? `${message.slice(0, 1999)}…` : message;
            return { content };
        }
        return {
            ...(evt.detail !== undefined ? { detail: evt.detail } : {}),
            event: "beflow.escalation",
            issue: { key: evt.key, title: evt.title },
            reason: evt.reason,
            text: message,
        };
    }

    public async notify(evt: NotifyEvent): Promise<void> {
        const phrases: Record<NotifyReason, string> = {
            blocked: "is blocked",
            failed: "failed",
            needs_input: "needs input",
            reminder: "is still waiting",
            resolved: "is resolved",
        };
        const phrase = phrases[evt.reason];
        const headline = `🔔 beflow: ${evt.key} ${phrase} — ${evt.title}`;
        const message = headline + (evt.detail !== undefined ? `\n${evt.detail}` : "");

        const body: Record<string, unknown> = this.buildBody(evt, message);

        const fetchFn: FetchFn = this.fetchImpl ?? fetch;
        try {
            const res = await fetchFn(this.url, {
                body: JSON.stringify(body),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            if (!res.ok) {
                this.log(`beflow: webhook notify failed (${String(res.status)} ${res.statusText})`);
            }
        } catch (err) {
            this.log(`beflow: webhook notify error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

export function createNotifier(opts: {
    fetchImpl?: FetchFn;
    format?: NotifyFormat;
    log?: (m: string) => void;
    webhookUrl?: string;
}): Notifier {
    if (opts.webhookUrl !== undefined && opts.webhookUrl !== "") {
        return new WebhookNotifier({
            fetchImpl: opts.fetchImpl,
            ...(opts.format !== undefined ? { format: opts.format } : {}),
            log: opts.log,
            url: opts.webhookUrl,
        });
    }
    return noopNotifier;
}

export function escalationDetail(report: { questions?: string[]; summary: string }): string {
    if (report.questions !== undefined && report.questions.length > 0) {
        return report.questions.map((q) => `- ${q}`).join("\n");
    }
    return report.summary;
}

export async function notifyEscalation(
    notifier: Notifier | undefined,
    issue: { key: string; title: string },
    reason: NotifyReason,
    detail?: string,
): Promise<void> {
    if (notifier === undefined) {
        return;
    }
    await notifier.notify({
        ...(detail !== undefined ? { detail } : {}),
        key: issue.key,
        reason,
        title: issue.title,
    });
}
