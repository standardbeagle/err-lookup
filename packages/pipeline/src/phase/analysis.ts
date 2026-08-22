import { createHash } from "node:crypto";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import type { BatchCheckpoint } from "../db/checkpoints.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { ProviderError } from "../provider/types.js";
import { withTimeout, TimeoutError } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { extractSourceRegion } from "../util/source.js";
import {
  analysisPrompt,
  type AnalysisNeed,
  type DiscoveredErrorJson,
  type EnrichedErrorJson,
  type DefenseStrategyJson,
} from "./prompts.js";

/** One provider call's worth of work: a batch of errors, the pass it answers,
 *  and the throwing regions aligned with it. */
interface AnalysisUnit {
  pass: AnalysisNeed;
  batch: DiscoveredErrorJson[];
  startIndex: number;
  sources: (string | null)[];
}

/** What a unit returns and what the checkpoint stores. */
interface AnalysisPayload {
  enriched: EnrichedErrorJson[];
  defenseStrategies: DefenseStrategyJson[];
}

/** Batches at or above this size are halved after a timeout; below it there is
 *  little size left to give back. Same floor discovery splits at.
 *
 *  The split happens once, never recursively, which is what keeps it free: a
 *  timeout no longer earns a second full-size attempt (provider/run.ts), so a
 *  batch that dies anyway costs one full-size call plus its two halves —
 *  exactly the two full-size attempts it replaces — while a batch the smaller
 *  size can digest is recovered instead of lost. */
const SPLIT_FLOOR = 10;

/** A timeout — the provider's own, or the phase watchdog's — is the failure a
 *  smaller batch can fix. Everything else (rate limit, parse, spawn) is not. */
function isSizeFixable(err: unknown): boolean {
  return err instanceof TimeoutError || (err instanceof ProviderError && err.kind === "timeout");
}

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
  onProgress?: (done: number, total: number) => void,
  onLog?: (msg: string) => void,
  checkpoint?: BatchCheckpoint
): Promise<AnalysisResult> {
  const started = Date.now();
  const enrichedByIndex = new Map<number, EnrichedErrorJson>();
  const defenseByIndex = new Map<number, DefenseStrategyJson>();

  const passes = resolvePasses(cfg, need);
  const batchSize = cfg.defaults.analysisBatchSize;
  const batches = chunk(discovered, batchSize);
  // Throwing regions are extracted procedurally once per batch and embedded in
  // the prompt — dense input instead of one file-read tool round trip per
  // error, which dominated the phase's wall-clock. ±12 lines keeps a 20-error
  // batch around 500 source lines.
  const sourcesByBatch = batches.map((batch) =>
    batch.map((e) =>
      typeof e.line === "number" && e.line > 0
        ? extractSourceRegion(repoPath, e.file, e.line, 12)?.sourceCode ?? null
        : null
    )
  );
  const units = passes.flatMap((pass) =>
    batches.map((batch, i) => ({ pass, batch, startIndex: i * batchSize, sources: sourcesByBatch[i]! }))
  );

  let lastProvider = "n/a";
  let failedBatches = 0;
  let done = 0;

  // Checkpoint key: pass + position + the batch's error identity. The
  // discovered list a resume works from is the persisted discovery result, so
  // positions are stable; the content hash guards against reusing an answer
  // for a batch whose input somehow shifted.
  const keyOf = (unit: AnalysisUnit): string => {
    const pass = unit.pass.enrichment ? (unit.pass.defense ? "both" : "enrichment") : "defense";
    const content = createHash("sha1")
      .update(unit.batch.map((e) => `${e.file}:${e.line}:${e.message}`).join("\n"))
      .digest("hex");
    return `${pass}:${unit.startIndex}:${content}`;
  };
  const applyParsed = (
    pass: AnalysisNeed,
    parsed: { enriched?: EnrichedErrorJson[]; defenseStrategies?: DefenseStrategyJson[] }
  ): void => {
    if (pass.enrichment) {
      for (const e of parsed.enriched ?? []) {
        if (typeof e?.errorIndex === "number") enrichedByIndex.set(e.errorIndex, e);
      }
    }
    if (pass.defense) {
      for (const d of parsed.defenseStrategies ?? []) {
        if (typeof d?.errorIndex === "number") defenseByIndex.set(d.errorIndex, d);
      }
    }
  };

  const label = (unit: AnalysisUnit): string =>
    `${unit.startIndex}-${unit.startIndex + unit.batch.length - 1}`;
  const half = (unit: AnalysisUnit, from: number, to: number): AnalysisUnit => ({
    pass: unit.pass,
    batch: unit.batch.slice(from, to),
    sources: unit.sources.slice(from, to),
    startIndex: unit.startIndex + from,
  });

  /** Run one unit, returning the payload it produced (or read back from the
   *  checkpoint) so a split parent can persist its halves' merged answer. */
  const runUnit = async (unit: AnalysisUnit, canSplit = true): Promise<AnalysisPayload | null> => {
    const routingPhase = unit.pass.enrichment ? "enrichment" : "defense";
    const key = keyOf(unit);
    const cached = checkpoint?.get(key);
    if (cached) {
      const payload = JSON.parse(cached) as AnalysisPayload;
      applyParsed(unit.pass, payload);
      return payload;
    }
    try {
      const budget = watchdogBudgetMs(cfg, routingPhase);
      const result = await withTimeout(
        runProvider(
          analysisPrompt(unit.batch, unit.startIndex, unit.pass, unit.sources),
          { cwd: repoPath },
          providers,
          cfg,
          routingPhase
        ),
        budget
      );
      lastProvider = result.providerUsed;
      const parsed = result.parsed as Partial<AnalysisPayload>;
      const payload: AnalysisPayload = {
        enriched: parsed.enriched ?? [],
        defenseStrategies: parsed.defenseStrategies ?? [],
      };
      // Persist only what applyParsed will read back, not the raw provider
      // output. A failed unit is deliberately never persisted — it retries on
      // the next resume, which also converts rate-limit losses into retries.
      checkpoint?.put(key, JSON.stringify(payload));
      applyParsed(unit.pass, payload);
      return payload;
    } catch (err) {
      // A timeout is the one failure the batch's own size can fix, and the
      // model has already been paid for it twice (runProvider retries once at
      // full size). Halve it instead of losing the errors, exactly as
      // discovery does. Rate-limit and parse failures are NOT split: more
      // calls against a pinned limit spend more of it for the same answer.
      if (canSplit && isSizeFixable(err) && unit.batch.length >= SPLIT_FLOOR) {
        onLog?.(`${routingPhase} batch at errors ${label(unit)} timed out — retrying as halves`);
        const mid = Math.ceil(unit.batch.length / 2);
        const first = await runUnit(half(unit, 0, mid), false);
        const second = await runUnit(half(unit, mid, unit.batch.length), false);
        if (!first || !second) return null;
        const merged: AnalysisPayload = {
          enriched: [...first.enriched, ...second.enriched],
          defenseStrategies: [...first.defenseStrategies, ...second.defenseStrategies],
        };
        // Persist the parent as well: without it every resume pays for the
        // oversized call again before rediscovering that it must split.
        checkpoint?.put(key, JSON.stringify(merged));
        return merged;
      }
      failedBatches++;
      const msg = err instanceof Error ? err.message : String(err);
      onLog?.(`${routingPhase} batch at errors ${label(unit)} failed: ${msg.slice(0, 300)}`);
      return null;
    }
  };

  await mapPool(units, cfg.defaults.batchConcurrency, async (unit) => {
    try {
      await runUnit(unit);
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
