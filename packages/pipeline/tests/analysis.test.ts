import { describe, it, expect } from "vitest";
import { runAnalysis } from "../src/phase/analysis.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import { sleep } from "../src/util/watchdog.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import type { DiscoveredErrorJson } from "../src/phase/prompts.js";

const EXPLAIN = "EXPLAIN the error";
const DEFEND = "DEFEND against the error";

function discovered(n: number): DiscoveredErrorJson[] {
  return Array.from({ length: n }, (_, i) => ({
    message: `boom ${i}`,
    type: "exception",
    file: "src/a.js",
    line: i + 1,
  }));
}

/** Records every prompt it sees and answers with payloads for the sections asked for. */
class RecordingProvider implements LlmProvider {
  readonly prompts: string[] = [];
  live = 0;
  peak = 0;
  constructor(
    readonly name: string,
    private readonly opts: { delayMs?: number; failPrompts?: (p: string) => boolean } = {}
  ) {}

  async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
    this.prompts.push(prompt);
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    try {
      if (this.opts.delayMs) await sleep(this.opts.delayMs);
      if (this.opts.failPrompts?.(prompt)) {
        return { ok: false, kind: "empty", error: "simulated batch failure" };
      }
      // Answer for exactly the indices this prompt lists.
      const indices = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
      const body: Record<string, unknown> = {};
      if (prompt.includes(EXPLAIN)) {
        body.enriched = indices.map((errorIndex) => ({
          errorIndex,
          documentation: "d",
          triggerScenarios: "t",
          commonSituations: "c",
          solutions: ["s"],
          exampleFix: null,
          severity: "error",
          tags: ["x"],
        }));
      }
      if (prompt.includes(DEFEND)) {
        body.defenseStrategies = indices.map((errorIndex) => ({
          errorIndex,
          handlingStrategy: "try-catch",
          validationCode: null,
          typeGuard: null,
          tryCatchPattern: null,
          preventionTips: ["p"],
        }));
      }
      return { ok: true, parsed: body, raw: JSON.stringify(body) };
    } finally {
      this.live--;
    }
  }
}

function cfgFrom(defaults: string[], phaseProviders: string[] = []): ReturnType<typeof mapConfig> {
  return mapConfig(
    parseKdl(
      [
        'provider "bulk" { command "bulk" }',
        'provider "strong" { command "strong" }',
        "defaults {",
        '  primary "bulk"',
        ...defaults,
        "}",
        ...(phaseProviders.length ? ["phase-providers {", ...phaseProviders, "}"] : []),
      ].join("\n")
    )
  );
}

const BOTH = { enrichment: true, defense: true };

describe("runAnalysis: fused enrichment + defense", () => {
  it("covers both phases in one call per batch", async () => {
    const p = new RecordingProvider("bulk");
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const res = await runAnalysis("/tmp/x", discovered(25), { bulk: p }, cfg, BOTH);

    // 25 errors / 10 per batch = 3 calls total, NOT 3 enrichment + 3 defense.
    expect(p.prompts).toHaveLength(3);
    expect(p.prompts.every((t) => t.includes(EXPLAIN) && t.includes(DEFEND))).toBe(true);
    expect(res.enrichedByIndex.size).toBe(25);
    expect(res.defenseByIndex.size).toBe(25);
    expect(res.failedBatches).toBe(0);
    // Indices stay absolute across batches, so the assembler can key on them.
    expect(res.enrichedByIndex.has(24)).toBe(true);
    expect(res.defenseByIndex.has(24)).toBe(true);
  });

  it("asks for only the phase that is still missing", async () => {
    const p = new RecordingProvider("bulk");
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const res = await runAnalysis("/tmp/x", discovered(10), { bulk: p }, cfg, {
      enrichment: false,
      defense: true,
    });

    expect(p.prompts).toHaveLength(1);
    expect(p.prompts[0]).toContain(DEFEND);
    expect(p.prompts[0]).not.toContain(EXPLAIN);
    expect(res.enrichedByIndex.size).toBe(0);
    expect(res.defenseByIndex.size).toBe(10);
  });

  it("splits back into two passes when the phases route to different providers", async () => {
    const bulk = new RecordingProvider("bulk");
    const strong = new RecordingProvider("strong");
    const cfg = cfgFrom(["  analysis-batch-size 10"], ['  defense "strong"']);
    const res = await runAnalysis("/tmp/x", discovered(10), { bulk, strong }, cfg, BOTH);

    // Fusing would have silently sent defense to the bulk model, ignoring routing.
    expect(bulk.prompts).toHaveLength(1);
    expect(bulk.prompts[0]).toContain(EXPLAIN);
    expect(bulk.prompts[0]).not.toContain(DEFEND);
    expect(strong.prompts).toHaveLength(1);
    expect(strong.prompts[0]).toContain(DEFEND);
    expect(strong.prompts[0]).not.toContain(EXPLAIN);
    expect(res.enrichedByIndex.size).toBe(10);
    expect(res.defenseByIndex.size).toBe(10);
  });

  it("keeps a failed batch non-fatal and reports the count", async () => {
    // Fail only the batch that starts at index 10.
    const p = new RecordingProvider("bulk", { failPrompts: (t) => t.includes("[10] ") });
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const res = await runAnalysis("/tmp/x", discovered(30), { bulk: p }, cfg, BOTH);

    expect(res.failedBatches).toBe(1);
    expect(res.batches).toBe(3);
    expect(res.enrichedByIndex.size).toBe(20); // the other two batches survived
    expect(res.enrichedByIndex.has(10)).toBe(false);
    expect(res.enrichedByIndex.has(0)).toBe(true);
    expect(res.enrichedByIndex.has(20)).toBe(true);
  });

  it("runs batches concurrently up to batch-concurrency", async () => {
    const p = new RecordingProvider("bulk", { delayMs: 40 });
    const cfg = cfgFrom(["  analysis-batch-size 10", "  batch-concurrency 4"]);
    const started = Date.now();
    const res = await runAnalysis("/tmp/x", discovered(80), { bulk: p }, cfg, BOTH);

    expect(res.batches).toBe(8);
    expect(p.peak).toBe(4);
    expect(res.enrichedByIndex.size).toBe(80);
    expect(Date.now() - started).toBeLessThan(250); // serial would be ~320ms
  });

  it("stays serial when batch-concurrency is left at the default", async () => {
    const p = new RecordingProvider("bulk", { delayMs: 5 });
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    await runAnalysis("/tmp/x", discovered(40), { bulk: p }, cfg, BOTH);
    expect(p.peak).toBe(1);
  });
});
