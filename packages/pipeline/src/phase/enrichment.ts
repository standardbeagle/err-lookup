import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { enrichmentPrompt, type DiscoveredErrorJson, type EnrichedErrorJson } from "./prompts.js";

export interface EnrichmentResult {
  /** Map from global error index → enrichment payload. */
  byIndex: Map<number, EnrichedErrorJson>;
  durationMs: number;
  providerUsed: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Phase 2 — Enrichment (§4.2.2). Batches 10 errors per LLM call. A failed batch
 * is non-fatal: that batch's errors are simply missing enrichment (the verify
 * phase flags gaps later).
 */
export async function runEnrichment(
  repoPath: string,
  discovered: DiscoveredErrorJson[],
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onBatch?: (batch: number, total: number) => void
): Promise<EnrichmentResult> {
  const started = Date.now();
  const batchSize = 10;
  const batches = chunk(discovered, batchSize);
  const byIndex = new Map<number, EnrichedErrorJson>();
  let lastProvider = "n/a";

  for (let i = 0; i < batches.length; i++) {
    onBatch?.(i + 1, batches.length);
    const batch = batches[i]!;
    const startIndex = i * batchSize;
    try {
      const primary = cfg.providers[cfg.defaults.primary];
      const budget = primary?.timeoutMs ?? 600_000;
      const result = await withTimeout(
        runProvider(enrichmentPrompt(batch, startIndex), { cwd: repoPath }, providers, cfg),
        budget
      );
      lastProvider = result.providerUsed;
      const parsed = result.parsed as { enriched?: EnrichedErrorJson[] };
      for (const e of parsed.enriched ?? []) {
        if (typeof e?.errorIndex === "number") byIndex.set(e.errorIndex, e);
      }
    } catch {
      // batch failed; skip — verify phase will flag missing enrichment
    }
  }

  return { byIndex, durationMs: Date.now() - started, providerUsed: lastProvider };
}
