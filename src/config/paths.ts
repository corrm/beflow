import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
    return join(homedir(), "beflow");
}

export function configPath(): string {
    return join(configDir(), "config.json");
}
