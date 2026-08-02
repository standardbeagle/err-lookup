import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscovery } from "../src/phase/discovery.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import { sleep } from "../src/util/watchdog.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";

/**
 * Discovery classifies 80 candidate sites per call, so the fixture repo needs
 * enough throw sites to produce several batches.
 */
const SITES = 200;
let repoPath: string;

beforeAll(() => {
  repoPath = mkdtempSync(join(tmpdir(), "discovery-test-"));
  const lines = Array.from({ length: SITES }, (_, i) => `if (x === ${i}) throw new Error("boom ${i}");`);
  writeFileSync(join(repoPath, "index.js"), lines.join("\n"));
});

afterAll(() => rmSync(repoPath, { recursive: true, force: true }));

/** Answers each classification batch with one error naming the first candidate line. */
class BatchProvider implements LlmProvider {
  live = 0;
  peak = 0;
  calls = 0;
  constructor(
    readonly name: string,
    private readonly opts: { delayMs?: number; failPrompts?: (p: string) => boolean } = {}
  ) {}

  async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
    this.calls++;
    this.live++;
    this.peak = Math.max(this.peak, this.live);
    try {
      if (this.opts.delayMs) await sleep(this.opts.delayMs);
      if (this.opts.failPrompts?.(prompt)) {
        return { ok: false, kind: "empty", error: "simulated discovery failure" };
      }
      // Echo back every candidate line in this batch, in the order given.
      const lines = [...prompt.matchAll(/"line":(\d+)/g)].map((m) => Number(m[1]));
      const errors = lines.map((line) => ({
        message: `boom line ${line}`,
        type: "exception",
        file: "index.js",
        line,
      }));
      return { ok: true, parsed: { errors }, raw: JSON.stringify({ errors }) };
    } finally {
      this.live--;
    }
  }
}

function cfg(extraDefaults: string[] = []) {
  return mapConfig(
    parseKdl(
      ['provider "bulk" { command "bulk" }', "defaults {", '  primary "bulk"', ...extraDefaults, "}"].join("\n")
    )
  );
}

describe("runDiscovery batching", () => {
  it("preserves candidate order when batches complete out of order", async () => {
    // Serial run establishes the reference ordering.
    const serial = new BatchProvider("bulk");
    const a = await runDiscovery(repoPath, { bulk: serial }, cfg());

    // Concurrent run with staggered latency, so batches finish out of order.
    const concurrent = new BatchProvider("bulk", { delayMs: 10 });
    const b = await runDiscovery(repoPath, { bulk: concurrent }, cfg(["  batch-concurrency 4"]));

    expect(concurrent.peak).toBeGreaterThan(1);
    expect(a.errors.length).toBeGreaterThan(0);
    // Same errors, same order — downstream error indices must not depend on
    // which batch happened to return first.
    expect(b.errors.map((e) => e.line)).toEqual(a.errors.map((e) => e.line));
  });

  it("fails the phase when a batch exhausts its retries — discovery gaps are not silently accepted", async () => {
    // Every attempt at the batch holding line 99 fails, so runProvider's retry
    // cannot rescue it and the whole phase must surface the failure.
    const p = new BatchProvider("bulk", { failPrompts: (t) => t.includes('"line":99,') });
    await expect(runDiscovery(repoPath, { bulk: p }, cfg(["  batch-concurrency 2"]))).rejects.toThrow();
  });

  it("recovers a batch that fails once, via the provider retry", async () => {
    let failed = false;
    const p = new BatchProvider("bulk", {
      failPrompts: (t) => {
        if (failed || !t.includes('"line":99,')) return false;
        failed = true;
        return true;
      },
    });
    const r = await runDiscovery(repoPath, { bulk: p }, cfg(["  batch-concurrency 2"]));
    expect(r.errors.some((e) => e.line === 99)).toBe(true);
  });
});
