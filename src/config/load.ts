import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { z } from "zod";

import { configSchema, fileSchema, registrySchema } from "./schema.ts";
import type { Config, ConfigFile, Registry } from "./schema.ts";

function loadFile<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        throw new Error(`beflow: cannot read config file at ${path}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`beflow: ${path} is not valid JSON: ${reason}`, { cause: err });
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
        throw new Error(`beflow: ${path} failed validation:\n${issues}`);
    }
    return result.data;
}

function loadConfigFile(dir: string): ConfigFile {
    return loadFile(join(dir, "config.json"), fileSchema);
}

export function loadConfig(dir: string = process.cwd()): Config {
    const file = loadConfigFile(dir);
    return configSchema.parse({ ...file, agents: file.agents ?? {} });
}

export function loadRegistry(dir: string = process.cwd()): Registry {
    const file = loadConfigFile(dir);
    return registrySchema.parse(file);
}
