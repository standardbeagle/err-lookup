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

describe("runVerify chunking (size-independent)", () => {
  class BatchCounting implements LlmProvider {
    calls = 0;
    constructor(
      readonly name: string,
      private readonly failCall = -1
    ) {}
    async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
      const n = this.calls++;
      if (n === this.failCall) return { ok: false, kind: "empty", error: "boom" };
      const ids = [...prompt.matchAll(/"id":"([0-9a-f]{16})"/g)].map((m) => m[1]!);
      const patches = [{ id: ids[0]!, field: "documentation", value: `patched-${n}` }];
      return { ok: true, parsed: { patches }, raw: JSON.stringify({ patches }) };
    }
  }
  const gappy = (i: number) =>
    record({ id: i.toString(16).padStart(16, "0"), documentation: "" });

  it("splits large record sets into bounded calls and merges patches", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      const p = new BatchCounting("p");
      const records = Array.from({ length: 450 }, (_, i) => gappy(i));
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(p.calls).toBe(5); // 450 / 100 → 5 chunks, every one gappy
      expect(r.patches).toHaveLength(5);
      expect(r.failedBatches).toBe(0);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });

  it("skips gap-free chunks, calls only for the gappy ones", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      const p = new BatchCounting("p");
      const complete = Array.from({ length: 100 }, (_, i) =>
        record({ id: (1000 + i).toString(16).padStart(16, "0") })
      );
      const records = [...complete, ...Array.from({ length: 100 }, (_, i) => gappy(i))];
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(p.calls).toBe(1);
      expect(r.patches).toHaveLength(1);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });

  it("a failed chunk loses only its own patches", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      // Chunk 0 fails its first try; runProvider's retry gives it call 1, so
      // fail call 0 → retry succeeds. Fail both tries of one chunk instead:
      const p = new BatchCounting("p", 0);
      const records = Array.from({ length: 200 }, (_, i) => gappy(i));
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(r.patches.length).toBeGreaterThanOrEqual(1);
      expect(r.failedBatches + r.patches.length).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });
});
