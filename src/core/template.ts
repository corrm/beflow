import type { Registry } from "../config/schema.ts";
import type { BoardTemplate } from "../trackers/tracker.ts";

const STATES: BoardTemplate["states"] = [
    { color: "#60646C", group: "backlog", name: "Backlog", sequence: 15000 },
    { color: "#60646C", group: "unstarted", name: "Todo", sequence: 25000 },
    { color: "#F59E0B", group: "started", name: "In Progress", sequence: 35000 },
    { color: "#EC4899", group: "started", name: "Needs Input", sequence: 37500 },
    { color: "#3B82F6", group: "started", name: "In Review", sequence: 40000 },
    { color: "#46A758", group: "completed", name: "Done", sequence: 45000 },
    { color: "#9AA4BC", group: "cancelled", name: "Cancelled", sequence: 55000 },
];

const TYPES: BoardTemplate["types"] = [
    {
        description: "A defect with a known or to-be-found root cause. Ready to fix.",
        name: "Bug",
    },
    {
        description: "New capability. May start as an idea, gets specced before build.",
        name: "Feature",
    },
    {
        description: "Refactor, dependency update, maintenance. No new behavior.",
        name: "Chore",
    },
    {
        description: "Time-boxed investigation. Output is findings/decision, not shipped code.",
        name: "Spike",
    },
];

// Functional/manual labels plus the runMode "picker" labels. The agent:<name>
// Pickers are appended per-project from the configured agent list.
const LABELS: BoardTemplate["labels"] = [
    { color: "#EF4444", name: "blocked" },
    { color: "#B91C1C", name: "failed" },
    { color: "#6B7280", name: "quarantined" },
    { color: "#14B8A6", name: "triaged" },
    { color: "#F59E0B", name: "needs-decision" },
    { color: "#8B5CF6", name: "customer-reported" },
    { color: "#F97316", name: "changes-requested" },
    { color: "#F59E0B", name: "run:autonomous" },
    { color: "#3B82F6", name: "run:supervised" },
    { color: "#A78BFA", name: "jobkind:triage" },
    { color: "#A78BFA", name: "jobkind:spec" },
    { color: "#A78BFA", name: "jobkind:implement" },
];

export function beflowBoardTemplate(registry: Registry, projectKey: string, agents: string[]): BoardTemplate {
    const project = registry.projects[projectKey];
    if (project === undefined) {
        const known = Object.keys(registry.projects).join(", ");
        throw new Error(`beflow: unknown project key "${projectKey}" (known: ${known})`);
    }

    const modules: BoardTemplate["modules"] = Object.keys(project.module_repo_map).map((name) => ({ name }));

    const labels: BoardTemplate["labels"] = [
        ...LABELS,
        ...agents.map((name) => ({ color: "#10B981", name: `agent:${name}` })),
    ];

    return { labels, modules, states: STATES, types: TYPES };
}
