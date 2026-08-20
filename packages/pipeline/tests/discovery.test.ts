import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";
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
  repoPath = tmpRepo("discovery-test-");
  const lines = Array.from({ length: SITES }, (_, i) => `if (x === ${i}) throw new Error("boom ${i}");`);
  writeFileSync(join(repoPath, "index.js"), lines.join("\n"));
});

afterAll(() => disposeRepo(repoPath));

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
      // Echo back this batch's candidates in the order given, parsed from the
      // prompt's CANDIDATES block. (A regex over the whole prompt over-counts:
      // context excerpts can repeat "line": patterns.)
      const block = prompt.slice(prompt.indexOf("CANDIDATES:") + "CANDIDATES:".length, prompt.indexOf("RULES:"));
      const candidates = JSON.parse(block.trim()) as { line: number }[];
      const lines = candidates.map((c) => c.line);
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
  // 30s: two real runDiscovery calls whose candidate extraction may cold-start
  // the lci index server; under a parallel turbo run that alone can pass 5s.
  it("preserves candidate order when batches complete out of order", { timeout: 30_000 }, async () => {
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

  it("releases the lci index server as soon as extraction is done", { timeout: 30_000 }, async () => {
    const { execFileSync } = await import("node:child_process");
    const p = new BatchProvider("bulk");
    await runDiscovery(repoPath, { bulk: p }, cfg());
    // The server must not outlive extraction and sit on index RAM through the
    // LLM phases. (Also holds when lci is absent — no server ever starts.)
    const listing = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" });
    const held = listing.split("\n").some((l) => /(^|\/)lci\s/.test(l) && l.includes(repoPath));
    expect(held).toBe(false);
  });

  it("splits an over-budget batch in half and recovers every candidate", async () => {
    // Any call carrying more than 20 candidates "times out" (golang/go: dense
    // stdlib sites blew the 600s call budget at the full batch size). Halved
    // calls fit, so discovery must deliver the complete candidate set.
    const tooDense = (t: string) =>
      (JSON.parse(t.slice(t.indexOf("CANDIDATES:") + "CANDIDATES:".length, t.indexOf("RULES:")).trim()) as unknown[])
        .length > 20;
    const p = new BatchProvider("bulk", { failPrompts: tooDense });
    const full = await runDiscovery(repoPath, { bulk: p }, cfg(["  batch-concurrency 2"]));
    const reference = await runDiscovery(repoPath, { bulk: new BatchProvider("bulk") }, cfg());

    expect(full.skippedCandidates).toBe(0);
    // Complete and in order despite every full-size call failing — downstream
    // error indices depend on the ordering.
    expect(full.errors.map((e) => e.line)).toEqual(reference.errors.map((e) => e.line));
  });

  it("abandons only the indigestible candidates and reports the gap", async () => {
    // The batch holding line 99 fails at every size, so splitting bottoms out
    // and its final sub-batch is dropped — counted, while the rest of the repo
    // still discovers. One bad batch must not erase a 20,000-site repo.
    const p = new BatchProvider("bulk", { failPrompts: (t) => t.includes('"line":99,') });
    const r = await runDiscovery(repoPath, { bulk: p }, cfg(["  batch-concurrency 2"]));
    const reference = await runDiscovery(repoPath, { bulk: new BatchProvider("bulk") }, cfg());

    expect(r.skippedCandidates).toBeGreaterThan(0);
    expect(r.skippedCandidates).toBeLessThan(10); // a minimal stub, not the batch
    expect(r.errors.length + r.skippedCandidates).toBe(reference.errors.length);
    expect(r.errors.some((e) => e.line === 99)).toBe(false);
    expect(r.errors.some((e) => e.line === 1)).toBe(true);
  });

  it("skips the agentic crawl on a docs-shaped repo — zero provider calls", async () => {
    // No extractable candidates and almost no source files: the whole-repo
    // agentic scan would spend a full provider call to confirm nothing.
    const docsRepo = tmpRepo("discovery-docs-");
    writeFileSync(join(docsRepo, "README.md"), "# just docs\n");
    writeFileSync(join(docsRepo, "GUIDE.md"), "# more docs\n");
    const p = new BatchProvider("bulk");
    const r = await runDiscovery(docsRepo, { bulk: p }, cfg());
    expect(r.mode).toBe("skipped-low-source");
    expect(r.errors).toEqual([]);
    expect(p.calls).toBe(0);
    disposeRepo(docsRepo);
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

describe("runDiscovery batch checkpointing", () => {
  const memCkpt = () => {
    const store = new Map<string, string>();
    return { store, get: (k: string) => store.get(k) ?? null, put: (k: string, v: string) => void store.set(k, v) };
  };

  it("resumes entirely from checkpoints — zero provider calls, identical output", { timeout: 30_000 }, async () => {
    const ckpt = memCkpt();
    const first = new BatchProvider("bulk");
    const a = await runDiscovery(repoPath, { bulk: first }, cfg(), undefined, undefined, undefined, ckpt);
    expect(first.calls).toBeGreaterThan(0);
    // A killed-and-relaunched drain: fresh provider, same persisted batches.
    const resumed = new BatchProvider("bulk");
    const b = await runDiscovery(repoPath, { bulk: resumed }, cfg(), undefined, undefined, undefined, ckpt);
    expect(resumed.calls).toBe(0);
    expect(b.errors.map((e) => e.line)).toEqual(a.errors.map((e) => e.line));
  });

  it("re-runs only the batches missing from the checkpoint", { timeout: 30_000 }, async () => {
    const ckpt = memCkpt();
    const a = await runDiscovery(repoPath, { bulk: new BatchProvider("bulk") }, cfg(), undefined, undefined, undefined, ckpt);
    const [firstKey] = ckpt.store.keys();
    ckpt.store.delete(firstKey!);
    const resumed = new BatchProvider("bulk");
    const b = await runDiscovery(repoPath, { bulk: resumed }, cfg(), undefined, undefined, undefined, ckpt);
    expect(resumed.calls).toBe(1);
    expect(b.errors.map((e) => e.line)).toEqual(a.errors.map((e) => e.line));
  });

  it("restores the abandoned-candidate count from checkpointed batches", { timeout: 30_000 }, async () => {
    const ckpt = memCkpt();
    const p = new BatchProvider("bulk", { failPrompts: (t) => t.includes('"line":99,') });
    const r1 = await runDiscovery(repoPath, { bulk: p }, cfg(["  batch-concurrency 2"]), undefined, undefined, undefined, ckpt);
    expect(r1.skippedCandidates).toBeGreaterThan(0);
    const resumed = new BatchProvider("bulk");
    const r2 = await runDiscovery(repoPath, { bulk: resumed }, cfg(), undefined, undefined, undefined, ckpt);
    expect(resumed.calls).toBe(0);
    expect(r2.skippedCandidates).toBe(r1.skippedCandidates);
    expect(r2.errors.map((e) => e.line)).toEqual(r1.errors.map((e) => e.line));
  });
});
