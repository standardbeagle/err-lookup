/**
 * Generate JSON Schema (Draft-07) from the zod schemas → packages/schema/schema.json.
 * Run via `pnpm gen-json-schema`. Called by `build`.
 *
 * The emitted schema.json is the language-agnostic contract published alongside
 * the TS types: third parties (and the MCP server in non-TS hosts) can validate
 * against it without pulling in zod.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ErrorEntry, RepoEntry, CURRENT_SCHEMA_VERSION } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "schema.json");

const jsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://errors.standardbeagle.com/schema.json",
  title: "ErrLookup Dataset",
  description: "Canonical schema for the err-lookup v2 error knowledge base.",
  schemaVersion: CURRENT_SCHEMA_VERSION,
  definitions: {
    ErrorEntry: zodToJsonSchema(ErrorEntry, "ErrorEntry").definitions?.ErrorEntry,
    RepoEntry: zodToJsonSchema(RepoEntry, "RepoEntry").definitions?.RepoEntry,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath}`);
