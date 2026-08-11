import { describe, it, expect } from "vitest";
import { runVerify } from "../src/phase/verify.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { ErrorEntry } from "@errlookup/schema";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";

function record(overrides: Partial<ErrorEntry> = {}): ErrorEntry {
  return {
    id: "0123456789abcdef",
    repo: "a/b",
    slug: "boom",
    errorCode: null,
    errorMessage: "boom",
    messagePattern: "boom",
    errorType: "exception",
    errorClass: null,
    httpStatus: null,
    severity: "error",
    filePath: "src/a.js",
    lineNumber: 1,
    sourceCode: "throw new Error('boom');",
    sourceCodeStart: 1,
    sourceCodeEnd: 1,
    githubUrl: "https://github.com/a/b/blob/deadbeef/src/a.js#L1",
    documentation: "It booms.",
    triggerScenarios: "Calling boom().",
    commonSituations: "Always.",
    solutions: ["do not call boom()"],
    exampleFix: null,
    handlingStrategy: "try-catch",
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: [],
    tags: [],
    analyzedSha: "deadbeef",
    analyzedAt: new Date().toISOString(),
    schemaVersion: 2,
    ...overrides,
  } as ErrorEntry;
}

class CountingProvider implements LlmProvider {
  calls = 0;
  constructor(readonly name: string) {}
  async invoke(_prompt: string, _opts: InvokeOptions): Promise<ProviderResult> {
    this.calls++;
    return { raw: '{"patches":[]}', parsed: { patches: [] }, providerUsed: this.name };
  }
}

const cfg = mapConfig(
  parseKdl(['provider "p" { command "p" }', "defaults {", '  primary "p"', "}"].join("\n"))
);

describe("runVerify gap gate", () => {
  it("skips the provider entirely when every record is complete", async () => {
    const p = new CountingProvider("p");
    const res = await runVerify("/tmp/x", [record(), record({ id: "fedcba9876543210", slug: "boom-2" })], { p }, cfg);
    expect(res.patches).toEqual([]);
    expect(res.providerUsed).toBe("none");
    expect(p.calls).toBe(0);
  });

  it("still calls the provider when a record has a gap", async () => {
    const p = new CountingProvider("p");
    await runVerify("/tmp/x", [record({ solutions: [] })], { p }, cfg);
    // ≥1, not ==1: the provider runner may retry within the call
    expect(p.calls).toBeGreaterThanOrEqual(1);
  });
});
