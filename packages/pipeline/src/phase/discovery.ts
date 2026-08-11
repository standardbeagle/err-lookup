import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { DISCOVERY_PROMPT, candidateDiscoveryPrompt, type DiscoveredErrorJson } from "./prompts.js";
import { extractCandidatesAuto } from "./candidates.js";
import { stopLciServer } from "../util/lci-server.js";

export interface DiscoveryResult {
  errors: DiscoveredErrorJson[];
  raw: string;
  providerUsed: string;
  durationMs: number;
  /** How candidates were sourced: lci / builtin extractor, or agentic scan. */
  mode: "candidates-lci" | "candidates-builtin" | "agentic";
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
  onBatch?: (done: number, total: number) => void
): Promise<DiscoveryResult> {
  const started = Date.now();
  const budget = watchdogBudgetMs(cfg, "discovery");

  const { candidates, backend } = extractCandidatesAuto(repoPath);
  // Candidate extraction is the index server's only consumer, but left alone
  // it survives until clone cleanup — on a symfony-class repo that is ~750MB
  // of index RAM held through 20-50min of LLM phases that never touch it.
  // Release it here; the cleanup-time stop stays as the backstop.
  if (backend === "lci") stopLciServer(repoPath);

  if (candidates.length === 0) {
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
    };
  }

  const batches = chunk(candidates, CANDIDATE_BATCH);

  // Classification batches are independent, so they run through a bounded pool.
  // mapPool preserves input order, which keeps the discovered error list — and
  // therefore every downstream error index — deterministic across runs.
  let done = 0;
  let providerUsed = "";
  let raw = "";
  const perBatch = await mapPool(batches, cfg.defaults.batchConcurrency, async (batch) => {
    try {
      const result = await withTimeout(
        runProvider(candidateDiscoveryPrompt(batch), { cwd: repoPath }, providers, cfg, "discovery"),
        budget
      );
      providerUsed = result.providerUsed;
      raw = result.raw;
      return parseErrors(result.parsed);
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
  };
}
