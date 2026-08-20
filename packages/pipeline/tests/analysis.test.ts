import { describe, it, expect } from "vitest";
import { runAnalysis } from "../src/phase/analysis.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import { sleep } from "../src/util/watchdog.js";
import { Semaphore } from "../src/util/pool.js";
import { ThrottledProvider } from "../src/provider/throttle.js";
import { buildProviders } from "../src/providers.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import type { DiscoveredErrorJson } from "../src/phase/prompts.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    private readonly opts: {
      delayMs?: number;
      failPrompts?: (p: string) => boolean;
      /** Hold every call open until releaseAll() — lets a test observe true
       *  peak concurrency instead of racing the scheduler. */
      holdOpen?: boolean;
    } = {}
  ) {}

  private held: (() => void)[] = [];
  private open = false;

  /** Release calls parked by holdOpen, now and for the rest of the test. */
  releaseAll(): void {
    this.open = true;
    for (const release of this.held.splice(0)) release();
  }

  async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
    this.prompts.push(prompt);
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    try {
      if (this.opts.delayMs) await sleep(this.opts.delayMs);
      if (this.opts.holdOpen && !this.open) {
        await new Promise<void>((resolve) => this.held.push(resolve));
      }
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

// Fake repo paths must be unique non-existent directories: a colliding real
// FILE at the same path turns runProvider's output-file cleanup into ENOTDIR
// failures that never reach the provider (seen with a stray /tmp/b).
const FAKE_REPO = join(tmpdir(), `errlookup-fake-${process.pid}`);
const FAKE_REPO_A = `${FAKE_REPO}-a`;
const FAKE_REPO_B = `${FAKE_REPO}-b`;

describe("runAnalysis: fused enrichment + defense", () => {
  it("covers both phases in one call per batch", async () => {
    const p = new RecordingProvider("bulk");
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const res = await runAnalysis(FAKE_REPO, discovered(25), { bulk: p }, cfg, BOTH);

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

  it("embeds the procedurally extracted throwing region in the prompt", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpRepo, disposeRepo } = await import("./tmp-repo.js");
    const dir = tmpRepo("ana-src-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.js"), `const guard = 'visible-neighbor-line';\nthrow new Error('boom 0');\n`);

    const p = new RecordingProvider("bulk");
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    await runAnalysis(dir, discovered(2), { bulk: p }, cfg, BOTH);

    // Error 0 points at a real line → its region rides along; error 1 points
    // past EOF... extractSourceRegion still clamps into the file, so both get
    // SOURCE blocks. The model reads code from the prompt, not via tool calls.
    expect(p.prompts[0]).toContain("SOURCE:");
    expect(p.prompts[0]).toContain("visible-neighbor-line");
    disposeRepo(dir);
  });

  it("asks for only the phase that is still missing", async () => {
    const p = new RecordingProvider("bulk");
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const res = await runAnalysis(FAKE_REPO, discovered(10), { bulk: p }, cfg, {
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
    const res = await runAnalysis(FAKE_REPO, discovered(10), { bulk, strong }, cfg, BOTH);

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
    const logs: string[] = [];
    const res = await runAnalysis(FAKE_REPO, discovered(30), { bulk: p }, cfg, BOTH, undefined, (m) =>
      logs.push(m)
    );

    expect(res.failedBatches).toBe(1);
    // The failure reason must reach the log, not be swallowed.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("errors 10-19 failed");
    expect(logs[0]).toContain("simulated batch failure");
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
    const res = await runAnalysis(FAKE_REPO, discovered(80), { bulk: p }, cfg, BOTH);

    expect(res.batches).toBe(8);
    expect(p.peak).toBe(4);
    expect(res.enrichedByIndex.size).toBe(80);
    expect(Date.now() - started).toBeLessThan(250); // serial would be ~320ms
  });

  it("stays serial when batch-concurrency is left at the default", async () => {
    const p = new RecordingProvider("bulk", { delayMs: 5 });
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    await runAnalysis(FAKE_REPO, discovered(40), { bulk: p }, cfg, BOTH);
    expect(p.peak).toBe(1);
  });
});

describe("provider rate-limit gate", () => {
  it("caps calls process-wide even when the two knobs over-subscribe", async () => {
    // 2 repos x 4 in-phase calls could put 8 calls in flight; the account allows 5.
    // Calls park until released, so demand must pile up to exactly the gate
    // width — the observation cannot depend on scheduler timing.
    const gate = new Semaphore(5);
    const raw = new RecordingProvider("bulk", { holdOpen: true });
    const throttled = new ThrottledProvider(raw, gate);
    const cfg = cfgFrom(["  analysis-batch-size 10", "  batch-concurrency 4"]);

    const runs = Promise.all([
      runAnalysis(FAKE_REPO_A, discovered(80), { bulk: throttled }, cfg, BOTH),
      runAnalysis(FAKE_REPO_B, discovered(80), { bulk: throttled }, cfg, BOTH),
    ]);
    // 8 workers demand slots; parked calls guarantee the gate saturates.
    for (let waited = 0; raw.live < 5 && waited < 5000; waited++) await sleep(1);
    raw.releaseAll();
    await runs;

    expect(raw.peak).toBeLessThanOrEqual(5);
    expect(raw.peak).toBe(5); // and it does use the whole allowance
    expect(gate.free).toBe(5);
  });

  it("buildProviders wires one shared gate across every provider", async () => {
    const cfg = mapConfig(
      parseKdl(
        [
          'provider "a" { command "a" }',
          'provider "b" { command "b" }',
          "defaults { primary \"a\"\n  provider-max-concurrent 2\n}",
        ].join("\n")
      )
    );
    const providers = buildProviders(cfg);
    // A shared gate means holding slots via one provider blocks the other —
    // per-provider gates would let each run at the full limit.
    expect(Object.keys(providers).sort()).toEqual(["a", "b"]);
    expect(providers.a).toBeInstanceOf(ThrottledProvider);
    expect(providers.b).toBeInstanceOf(ThrottledProvider);
  });

  it("leaves providers unwrapped when no limit is configured", () => {
    const cfg = mapConfig(parseKdl(['provider "a" { command "a" }', 'defaults { primary "a" }'].join("\n")));
    expect(buildProviders(cfg).a).not.toBeInstanceOf(ThrottledProvider);
  });
});

describe("runAnalysis batch checkpointing", () => {
  const memCkpt = () => {
    const store = new Map<string, string>();
    return { store, get: (k: string) => store.get(k) ?? null, put: (k: string, v: string) => void store.set(k, v) };
  };

  it("resumes from checkpoints without re-calling the provider", async () => {
    const ckpt = memCkpt();
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    const first = new RecordingProvider("bulk");
    const a = await runAnalysis(FAKE_REPO_A, discovered(25), { bulk: first }, cfg, BOTH, undefined, undefined, ckpt);
    expect(first.prompts).toHaveLength(3);
    expect(a.enrichedByIndex.size).toBe(25);
    const resumed = new RecordingProvider("bulk");
    const b = await runAnalysis(FAKE_REPO_A, discovered(25), { bulk: resumed }, cfg, BOTH, undefined, undefined, ckpt);
    expect(resumed.prompts).toHaveLength(0);
    expect(b.enrichedByIndex.size).toBe(25);
    expect(b.defenseByIndex.size).toBe(25);
  });

  it("retries failed batches on resume instead of reusing the failure", async () => {
    const ckpt = memCkpt();
    const cfg = cfgFrom(["  analysis-batch-size 10"]);
    // The batch carrying index 10 fails at every attempt on the first run.
    const failing = new RecordingProvider("bulk", { failPrompts: (t) => t.includes("[10]") });
    const a = await runAnalysis(FAKE_REPO_A, discovered(25), { bulk: failing }, cfg, BOTH, undefined, undefined, ckpt);
    expect(a.failedBatches).toBe(1);
    expect(a.enrichedByIndex.has(10)).toBe(false);
    // Resume: the two persisted batches load, only the failed one re-runs.
    const resumed = new RecordingProvider("bulk");
    const b = await runAnalysis(FAKE_REPO_A, discovered(25), { bulk: resumed }, cfg, BOTH, undefined, undefined, ckpt);
    expect(resumed.prompts).toHaveLength(1);
    expect(b.failedBatches).toBe(0);
    expect(b.enrichedByIndex.size).toBe(25);
  });
});
