import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
    return join(homedir(), "beflow");
}

export function configPath(): string {
    return join(configDir(), "config.json");
}

export const CONFIG_BOOTSTRAP: string =
    JSON.stringify(
        {
            $schema: "https://raw.githubusercontent.com/corrm/beflow/main/config.schema.json",
            agent: "claude",
            agents: {
                claude: {
                    args: ["--dangerously-skip-permissions"],
                    command: "claude",
                },
            },
            projects: {},
            runMode: "supervised",
            tracker: "plane",
            trackers: {
                linear: { apiKeyEnv: "LINEAR_API_KEY" },
                plane: {
                    apiKeyEnv: "PLANE_API_KEY",
                    baseUrl: "https://api.plane.so",
                    workspaceSlug: "your-workspace",
                },
            },
            workspace: {
                id: "your-workspace-id",
                slug: "your-workspace",
            },
        },
        null,
        2,
    ) + "\n";
