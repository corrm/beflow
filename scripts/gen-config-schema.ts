/// <reference types="node" />
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import { fileSchema } from "../src/config/schema.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const outPath = join(repoRoot, "config.schema.json");

const schema: object = zodToJsonSchema(fileSchema, {
    $refStrategy: "none",
    name: "BeflowConfig",
});

writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`beflow: wrote ${outPath}`);
