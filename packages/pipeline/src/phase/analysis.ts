import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import {
  analysisPrompt,
  type AnalysisNeed,
  type DiscoveredErrorJson,
  type EnrichedErrorJson,
  type DefenseStrategyJson,
} from "./prompts.js";

export interface AnalysisResult {
  /** Global error index → enrichment payload (empty when not requested). */
  enrichedByIndex: Map<number, EnrichedErrorJson>;
  /** Global error index → defense payload (empty when not requested). */
  defenseByIndex: Map<number, DefenseStrategyJson>;
  durationMs: number;
  providerUsed: string;
  /** Batches whose call failed outright; their errors simply lack these fields. */
  failedBatches: number;
  batches: number;
}

/**
 * Phases 2+3 (§4.2.2/§4.2.3) over one repo's discovered errors.
 *
 * Batches are independent — each returns payloads keyed by absolute error index
 * — so they run through a bounded pool at `defaults.batch-concurrency`. A failed
 * batch stays non-fatal: those errors are missing enrichment/defense and the
 * verify phase flags the gap, exactly as when batches ran serially.
 *
 * The two phases share one call per batch unless provider routing sends them to
 * different models, in which case each gets its own pass so `phase-providers`
 * is honoured rather than silently ignored.
 */
export async function runAnalysis(
  repoPath: string,
  discovered: DiscoveredErrorJson[],
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  need: AnalysisNeed,
  onProgress?: (done: number, total: number) => void
): Promise<AnalysisResult> {
  const started = Date.now();
  const enrichedByIndex = new Map<number, EnrichedErrorJson>();
  const defenseByIndex = new Map<number, DefenseStrategyJson>();

  const passes = resolvePasses(cfg, need);
  const batchSize = cfg.defaults.analysisBatchSize;
  const batches = chunk(discovered, batchSize);
  const units = passes.flatMap((pass) => batches.map((batch, i) => ({ pass, batch, startIndex: i * batchSize })));

  let lastProvider = "n/a";
  let failedBatches = 0;
  let done = 0;

  await mapPool(units, cfg.defaults.batchConcurrency, async (unit) => {
    try {
      const routingPhase = unit.pass.enrichment ? "enrichment" : "defense";
      const budget = cfg.providers[cfg.phaseProviders?.[routingPhase] ?? cfg.defaults.primary]?.timeoutMs ?? 600_000;
      const result = await withTimeout(
        runProvider(
          analysisPrompt(unit.batch, unit.startIndex, unit.pass),
          { cwd: repoPath },
          providers,
          cfg,
          routingPhase
        ),
        budget
      );
      lastProvider = result.providerUsed;
      const parsed = result.parsed as {
        enriched?: EnrichedErrorJson[];
        defenseStrategies?: DefenseStrategyJson[];
      };
      if (unit.pass.enrichment) {
        for (const e of parsed.enriched ?? []) {
          if (typeof e?.errorIndex === "number") enrichedByIndex.set(e.errorIndex, e);
        }
      }
      if (unit.pass.defense) {
        for (const d of parsed.defenseStrategies ?? []) {
          if (typeof d?.errorIndex === "number") defenseByIndex.set(d.errorIndex, d);
        }
      }
    } catch {
      failedBatches++;
    } finally {
      onProgress?.(++done, units.length);
    }
  });

  return {
    enrichedByIndex,
    defenseByIndex,
    durationMs: Date.now() - started,
    providerUsed: lastProvider,
    failedBatches,
    batches: units.length,
  };
}

/**
 * One fused pass when both phases are wanted and route to the same provider;
 * otherwise a pass per wanted phase.
 */
function resolvePasses(cfg: ErrlookupConfig, need: AnalysisNeed): AnalysisNeed[] {
  if (!need.enrichment && !need.defense) return [];
  if (!need.enrichment) return [{ enrichment: false, defense: true }];
  if (!need.defense) return [{ enrichment: true, defense: false }];

  const providerFor = (p: "enrichment" | "defense") => cfg.phaseProviders?.[p] ?? cfg.defaults.primary;
  if (providerFor("enrichment") !== providerFor("defense")) {
    return [
      { enrichment: true, defense: false },
      { enrichment: false, defense: true },
    ];
  }
  return [{ enrichment: true, defense: true }];
}
