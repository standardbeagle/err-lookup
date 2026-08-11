import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { DISCOVERY_PROMPT, candidateDiscoveryPrompt, type DiscoveredErrorJson } from "./prompts.js";
import { extractCandidatesAuto, countSourceFiles } from "./candidates.js";
import { stopLciServer } from "../util/lci-server.js";

export interface DiscoveryResult {
  errors: DiscoveredErrorJson[];
  raw: string;
  providerUsed: string;
  durationMs: number;
  /** How candidates were sourced: lci / builtin extractor, or agentic scan —
   *  or skipped-low-source when the repo has too little code to justify one. */
  mode: "candidates-lci" | "candidates-builtin" | "agentic" | "skipped-low-source";
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
  onLog?: (msg: string) => void
): Promise<DiscoveryResult> {
  const started = Date.now();
  const budget = watchdogBudgetMs(cfg, "discovery");

  const { candidates, backend } = extractCandidatesAuto(repoPath, {}, onLog);
  // Candidate extraction is the index server's only consumer, but left alone
  // it survives until clone cleanup — on a symfony-class repo that is ~750MB
  // of index RAM held through 20-50min of LLM phases that never touch it.
  // Release it here; the cleanup-time stop stays as the backstop.
  if (backend === "lci") stopLciServer(repoPath);

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
    const result = await withTimeout(
      runProvider(DISCOVERY_PROMPT, { cwd: repoPath }, providers, cfg, "discovery"),
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
  const classify = async (batch: typeof candidates): Promise<DiscoveredErrorJson[]> => {
    try {
      const result = await withTimeout(
        runProvider(candidateDiscoveryPrompt(batch), { cwd: repoPath }, providers, cfg, "discovery"),
        budget
      );
      providerUsed = result.providerUsed;
      raw = result.raw;
      return parseErrors(result.parsed);
    } catch (e) {
      if (batch.length >= 10) {
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = [batch.slice(0, mid), batch.slice(mid)];
        return [...(await classify(a)), ...(await classify(b))];
      }
      skippedCandidates += batch.length;
      return [];
    }
  };

  const perBatch = await mapPool(batches, cfg.defaults.batchConcurrency, async (batch) => {
    try {
      return await classify(batch);
    } finally {
      onBatch?.(++done, batches.length);
    }
  });

  return {
    errors: perBatch.flat(),
    raw,
    providerUsed,
    durationMs: Date.now() - started,
    mode: backend === "lci" ? "candidates-lci" : "candidates-builtin",
    skippedCandidates,
  };
}
