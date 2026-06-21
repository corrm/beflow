import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// The single place beflow reads `XDG_*` env vars. Per the XDG Base Directory
// Spec a value is honored only when set AND absolute; otherwise it is ignored
// And the spec fallback under the home dir applies. Every on-disk path helper
// Routes through these three functions — no scattered env reads or homedir joins.
function xdgRoot(envVar: string, fallbackSubpath: string[]): string {
    const value = process.env[envVar];
    const base = value !== undefined && isAbsolute(value) ? value : join(homedir(), ...fallbackSubpath);
    return join(base, "beflow");
}

export function xdgConfigHome(): string {
    return xdgRoot("XDG_CONFIG_HOME", [".config"]);
}

export function xdgStateHome(): string {
    return xdgRoot("XDG_STATE_HOME", [".local", "state"]);
}

export function xdgDataHome(): string {
    return xdgRoot("XDG_DATA_HOME", [".local", "share"]);
}
