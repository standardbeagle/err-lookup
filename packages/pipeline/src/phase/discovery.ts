import { createHash } from "node:crypto";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import type { BatchCheckpoint } from "../db/checkpoints.js";
import { runProvider, watchdogBudgetMs, isQuotaShapedError } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { DISCOVERY_PROMPT, candidateDiscoveryPrompt, type DiscoveredErrorJson } from "./prompts.js";
import { extractCandidatesAuto, countSourceFiles, type ScanScope, type CandidateFilter } from "./candidates.js";
import { stopLciServer } from "../util/lci-server.js";

export interface DiscoveryResult {
  errors: DiscoveredErrorJson[];
  raw: string;
  providerUsed: string;
  durationMs: number;
  /** How candidates were sourced: lci / builtin extractor, or agentic scan —
   *  or skipped-low-source when the repo has too little code to justify one. */
  mode: "candidates-lci" | "candidates-builtin" | "agentic" | "skipped-low-source" | "delta-no-candidates";
  /** Candidates abandoned after batch-splitting retries — logged, not fatal. */
  skippedCandidates: number;
}

/** Below this many source files, a candidate-less repo skips the agentic scan
 *  (default 5). Docs/list/config repos sit at 0-2; the whole-repo LLM crawl on
 *  them costs a full provider call to confirm there is nothing to find. */
function minAgenticSourceFiles(): number {
  const n = Number(process.env.ERRLOOKUP_MIN_AGENTIC_SOURCE_FILES ?? 5);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

// 40, down from 80: heavyweight candidate sites made 80-per-call discovery
// batches overrun the 600s per-call provider timeout on large repos (every
// one of the 37 failed repos died there). Half-size calls fit the budget,
// spread across more gate slots, and leave retry/fallback something to save.
const CANDIDATE_BATCH = 40;

function parseErrors(parsed: unknown): DiscoveredErrorJson[] {
  const p = parsed as { errors?: DiscoveredErrorJson[] };
  return Array.isArray(p?.errors) ? p.errors!.filter((e) => e && typeof e.message === "string") : [];
}

/**
 * Phase 1 — Discovery (§4.2.1). Deterministic candidate extraction feeds the
 * model dense classification batches (cheap models judge concrete sites far
 * better than they search, and one message carries ~80 sites). The agentic
 * whole-repo scan runs only when extraction finds nothing (e.g. a language
 * the extractor does not cover). Wrapped in the phase-level watchdog timeout.
 */
export async function runDiscovery(
  repoPath: string,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onBatch?: (done: number, total: number) => void,
  onLog?: (msg: string) => void,
  scope?: ScanScope,
  checkpoint?: BatchCheckpoint,
  /** Incremental rescan: classify only candidates inside the changed hunks. */
  only?: CandidateFilter
): Promise<DiscoveryResult> {
  const started = Date.now();
  const budget = watchdogBudgetMs(cfg, "discovery");

  const { candidates, backend } = extractCandidatesAuto(repoPath, { scope, only }, onLog);
  // Candidate extraction is the index server's only consumer, but left alone
  // it survives until clone cleanup — on a symfony-class repo that is ~750MB
  // of index RAM held through 20-50min of LLM phases that never touch it.
  // Release it here; the cleanup-time stop stays as the backstop.
  if (backend === "lci") stopLciServer(repoPath);

  if (candidates.length === 0 && only) {
    // A diff-scoped extraction that finds nothing means the edits touched no
    // error-raising site. The agentic crawl below would re-explore the whole
    // repo — the one thing an incremental rescan exists to avoid.
    return { errors: [], raw: "", providerUsed: "none", durationMs: Date.now() - started, mode: "delta-no-candidates", skippedCandidates: 0 };
  }
  if (candidates.length === 0) {
    // Active ingestion filter: no extracted candidates AND next to no source
    // files means a docs-shaped repo. Confirming the obvious with a whole-repo
    // agentic crawl is the single most wasteful call in the pipeline — skip it.
    const sourceFiles = countSourceFiles(repoPath);
    if (sourceFiles < minAgenticSourceFiles()) {
      return {
        errors: [],
        raw: "",
        providerUsed: "none",
        durationMs: Date.now() - started,
        mode: "skipped-low-source",
        skippedCandidates: 0,
      };
    }
    // The agentic crawl explores the repo itself, so the scope rides along as
    // prompt constraints instead of a path filter.
    const scopeNote =
      scope && (scope.includeRoots.length > 0 || scope.excludeDirs.length > 0)
        ? `\n\nSCAN SCOPE:${scope.includeRoots.length > 0 ? ` only scan these directories: ${scope.includeRoots.join(", ")}.` : ""}${scope.excludeDirs.length > 0 ? ` NEVER scan: ${scope.excludeDirs.join(", ")}.` : ""}`
        : "";
    const result = await withTimeout(
      runProvider(DISCOVERY_PROMPT + scopeNote, { cwd: repoPath }, providers, cfg, "discovery"),
      budget
    );
    return {
      errors: parseErrors(result.parsed),
      raw: result.raw,
      providerUsed: result.providerUsed,
      durationMs: Date.now() - started,
      mode: "agentic",
      skippedCandidates: 0,
    };
  }

  const batches = chunk(candidates, CANDIDATE_BATCH);

  // Classification batches are independent, so they run through a bounded pool.
  // mapPool preserves input order, which keeps the discovered error list — and
  // therefore every downstream error index — deterministic across runs.
  let done = 0;
  let providerUsed = "";
  let raw = "";
  let skippedCandidates = 0;

  // A batch that exhausts retry + fallback (golang/go: dense stdlib sites blew
  // the per-call timeout even at 40) splits in half and each half tries again —
  // smaller calls fit the budget. A stub that still fails abandons only its own
  // candidates: one indigestible batch must not fail a 20,000-site repo.
  const classify = async (
    batch: typeof candidates
  ): Promise<{ errors: DiscoveredErrorJson[]; skipped: number }> => {
    try {
      const result = await withTimeout(
        runProvider(candidateDiscoveryPrompt(batch), { cwd: repoPath }, providers, cfg, "discovery"),
        budget
      );
      providerUsed = result.providerUsed;
      raw = result.raw;
      return { errors: parseErrors(result.parsed), skipped: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Quota-shaped failures are not size problems — splitting doubles the
      // calls thrown at a spent account. Abandon whole (same guard as verify).
      if (batch.length >= 10 && !isQuotaShapedError(msg)) {
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = [await classify(batch.slice(0, mid)), await classify(batch.slice(mid))];
        return { errors: [...a.errors, ...b.errors], skipped: a.skipped + b.skipped };
      }
      return { errors: [], skipped: batch.length };
    }
  };

  // Checkpoint key: the batch's candidate identity, not its position — the
  // candidate list is deterministic per SHA+scope, but content addressing means
  // a resume whose extraction shifted (lci vs builtin backend) simply misses
  // and re-runs instead of reusing a wrong answer.
  const keyOf = (batch: typeof candidates): string =>
    createHash("sha1")
      .update(batch.map((c) => `${c.file}:${c.line}`).join("\n"))
      .digest("hex");

  const perBatch = await mapPool(batches, cfg.defaults.batchConcurrency, async (batch) => {
    try {
      const key = keyOf(batch);
      const cached = checkpoint?.get(key);
      if (cached) {
        const r = JSON.parse(cached) as { errors: DiscoveredErrorJson[]; skipped: number };
        skippedCandidates += r.skipped;
        return r.errors;
      }
      const r = await classify(batch);
      checkpoint?.put(key, JSON.stringify(r));
      skippedCandidates += r.skipped;
      return r.errors;
    } finally {
      onBatch?.(++done, batches.length);
    }
  });

  return {
    errors: perBatch.flat(),
    raw,
    providerUsed: providerUsed || "checkpoint",
    durationMs: Date.now() - started,
    mode: backend === "lci" ? "candidates-lci" : "candidates-builtin",
    skippedCandidates,
  };
}
