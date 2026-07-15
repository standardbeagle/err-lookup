import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "..", "schema.json");

function runGen() {
  // Uses tsx via pnpm script.NODE_PATH; call the script directly to avoid pnpm overhead in CI.
  execFileSync(process.execPath, ["--import", "tsx", resolve(__dirname, "..", "scripts", "gen-json-schema.ts")], {
    cwd: resolve(__dirname, ".."),
    stdio: "pipe",
  });
}

describe("JSON Schema generation", () => {
  it("emits schema.json with ErrorEntry + RepoEntry definitions", () => {
    runGen();
    expect(existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.$schema).toContain("draft-07");
    expect(schema.schemaVersion).toBe(2);
    expect(schema.definitions.ErrorEntry).toBeTruthy();
    expect(schema.definitions.RepoEntry).toBeTruthy();
    expect(schema.definitions.ErrorEntry.type).toBe("object");
    expect(schema.definitions.ErrorEntry.properties.id).toBeTruthy();
    expect(schema.definitions.ErrorEntry.properties.schemaVersion.const).toBe(2);
  });
});
