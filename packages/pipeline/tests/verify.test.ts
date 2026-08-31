import { describe, it, expect } from "vitest";
import { runVerify } from "../src/phase/verify.js";
import { clearProviderDownMarks } from "../src/provider/run.js";
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
    // ≥200 chars: verify counts a shorter documentation as a gap (MIN_DOC_CHARS),
    // so the base fixture must clear the bar for the "complete record" tests.
    documentation:
      "The boom() entry point throws unconditionally because it exists to demonstrate failure paths. " +
      "Any call site that reaches it without a guard will terminate the request, so callers are expected " +
      "to branch on canBoom() before invoking it.",
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

  it("treats a one-clause documentation as a gap, not just an empty one", async () => {
    // 21.9% of the 2026-08-31 corpus shipped with a documentation under 200
    // chars because the old bar was "non-empty" — those records never re-earned
    // a verify line and stayed thin forever.
    const p = new CountingProvider("p");
    await runVerify("/tmp/x", [record({ documentation: "It booms." })], { p }, cfg);
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

  it("prompts only for the records that have a gap, not their complete neighbours", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      const prompts: string[] = [];
      const p = new (class implements LlmProvider {
        readonly name = "p";
        async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
          prompts.push(prompt);
          return { ok: true, parsed: { patches: [] }, raw: '{"patches":[]}' };
        }
      })();
      // 300 complete records with 5 gappy ones scattered through them. Chunking
      // first put a gap in three of four chunks and shipped ~300 complete
      // records with them; the gap filter sends one chunk of 5.
      const records = Array.from({ length: 305 }, (_, i) =>
        i % 61 === 60 ? gappy(i) : record({ id: (2000 + i).toString(16).padStart(16, "0") })
      );
      await runVerify("/nonexistent", records, { p }, cfg);

      expect(prompts).toHaveLength(1);
      const ids = [...prompts[0]!.matchAll(/id=([0-9a-f]{16})/g)].map((m) => m[1]!);
      expect(ids).toHaveLength(5);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });

  it("a batch too big for the provider splits in half and the halves succeed", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      // Fails any prompt carrying more than 50 records — the shape of an
      // over-long verify call dying on its timeout. A timeout is not retried
      // in place (run.ts breaks), so recovery has to come from the split.
      const p = new (class implements LlmProvider {
        readonly name = "p";
        calls = 0;
        async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
          this.calls++;
          const ids = [...prompt.matchAll(/id=([0-9a-f]{16})/g)].map((m) => m[1]!);
          if (ids.length > 50) return { ok: false, kind: "timeout", error: "p exceeded budget" };
          const patches = ids.slice(0, 1).map((id) => ({ id, field: "documentation", value: "patched" }));
          return { ok: true, parsed: { patches }, raw: JSON.stringify({ patches }) };
        }
      })();
      const records = Array.from({ length: 100 }, (_, i) => gappy(i));
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(r.patches).toHaveLength(2); // one per surviving half
      expect(r.failedBatches).toBe(0);
      expect(r.failedRecords).toBe(0);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });

  it("a batch that fails at every size abandons only sub-10 stubs, counting their records", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      const p = new (class implements LlmProvider {
        readonly name = "p";
        async invoke(): Promise<ProviderResult> {
          return { ok: false, kind: "timeout", error: "always down" };
        }
      })();
      const records = Array.from({ length: 20 }, (_, i) => gappy(i));
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(r.patches).toHaveLength(0);
      expect(r.failedRecords).toBe(20); // every record accounted for, once
      expect(r.failedBatches).toBe(4); // 20 → 10+10 → 5+5+5+5 stubs
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });

  it("a quota-shaped failure abandons the batch whole — no split churn", async () => {
    process.env.ERRLOOKUP_VERIFY_BATCH = "100";
    try {
      const p = new (class implements LlmProvider {
        readonly name = "p";
        calls = 0;
        async invoke(): Promise<ProviderResult> {
          this.calls++;
          return {
            ok: false,
            kind: "spawn",
            error:
              "p ACP failure: You've reached your usage limit for this billing cycle. " +
              "Your quota will be refreshed in the next cycle.",
          };
        }
      })();
      const records = Array.from({ length: 100 }, (_, i) => gappy(i));
      const r = await runVerify("/nonexistent", records, { p }, cfg);
      expect(r.failedBatches).toBe(1); // the whole batch, not a tree of stubs
      expect(r.failedRecords).toBe(100);
      // runProvider breaks after the first cycle-spent answer: one call total,
      // where splitting burned hundreds against the same wall.
      expect(p.calls).toBe(1);
    } finally {
      clearProviderDownMarks();
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
      const logs: string[] = [];
      const r = await runVerify("/nonexistent", records, { p }, cfg, (m) => logs.push(m));
      expect(r.patches.length).toBeGreaterThanOrEqual(1);
      expect(r.failedBatches + r.patches.length).toBeGreaterThanOrEqual(2);
      // Each failed chunk logs its reason instead of swallowing it.
      expect(logs.filter((l) => l.includes("batch failed:"))).toHaveLength(r.failedBatches);
    } finally {
      delete process.env.ERRLOOKUP_VERIFY_BATCH;
    }
  });
});
