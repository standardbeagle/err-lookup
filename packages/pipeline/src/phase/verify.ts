import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { verifyPrompt, type VerifyPatchJson } from "./prompts.js";
import type { ErrorEntry } from "@errlookup/schema";

export interface VerifyResult {
  patches: VerifyPatchJson[];
  durationMs: number;
  providerUsed: string;
  /** Verify chunks that exhausted retries — their records go unpatched. */
  failedBatches: number;
}

/** Records per verify call (ERRLOOKUP_VERIFY_BATCH, default 200). One call
 *  over the whole record set blew up on exactly the biggest repos — the
 *  1,352-record elasticsearch prompt failed every provider it was sent to. */
function verifyBatchSize(): number {
  const n = Number(process.env.ERRLOOKUP_VERIFY_BATCH ?? 200);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

/** Phase 5 — Verify (§4.2.5): review records for gaps, return patches (not applied here). */
export async function runVerify(
  repoPath: string,
  records: ErrorEntry[],
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onLog?: (msg: string) => void
): Promise<VerifyResult> {
  const started = Date.now();
  const compact = records.map((r) => ({
    id: r.id,
    message: r.errorMessage,
    file: r.filePath,
    line: r.lineNumber,
    hasDoc: r.documentation.trim().length > 0,
    hasSolutions: r.solutions.length > 0,
    hasSource: r.sourceCode !== null && r.sourceCode.trim().length > 0,
    hasDefense: r.handlingStrategy !== null || r.preventionTips.length > 0,
  }));
  // The provider's only job here is filling gaps; a chunk whose compact view
  // shows none would return zero patches by instruction. Skip those chunks —
  // on a healthy run this makes verify free regardless of repo size.
  const withGaps = chunk(compact, verifyBatchSize()).filter(
    (c) => !c.every((r) => r.hasDoc && r.hasSolutions && r.hasSource && r.hasDefense)
  );
  if (withGaps.length === 0) {
    onLog?.("verify: no gaps — provider calls skipped");
    return { patches: [], durationMs: Date.now() - started, providerUsed: "none", failedBatches: 0 };
  }
  // Budget keyed to the verify-phase provider (it used to read the default
  // primary's timeout while routing the call to the verify provider).
  const budget = watchdogBudgetMs(cfg, "verify");
  let providerUsed = "n/a";
  let failedBatches = 0;
  const perBatch = await mapPool(withGaps, cfg.defaults.batchConcurrency, async (batch) => {
    try {
      const result = await withTimeout(
        runProvider(verifyPrompt(batch), { cwd: repoPath }, providers, cfg, "verify"),
        budget
      );
      providerUsed = result.providerUsed;
      const parsed = result.parsed as { patches?: VerifyPatchJson[] };
      return parsed.patches ?? [];
    } catch {
      failedBatches++;
      return [];
    }
  });
  const patches = perBatch.flat();
  onLog?.(
    `verify: ${patches.length} patches over ${withGaps.length} batches via ${providerUsed}` +
      (failedBatches > 0 ? ` (${failedBatches} batches failed — their records go unpatched)` : "")
  );
  return { patches, durationMs: Date.now() - started, providerUsed, failedBatches };
}

/**
 * Apply verify patches to records. Only patches with a known id + field are
 * applied; the result is re-validated, invalid patches are dropped (not silent).
 */
export function applyPatches(
  records: ErrorEntry[],
  patches: VerifyPatchJson[]
): { records: ErrorEntry[]; applied: number; rejected: number } {
  const byId = new Map(records.map((r) => [r.id, { ...r, ...r }]));
  let applied = 0;
  let rejected = 0;
  for (const p of patches) {
    const rec = byId.get(p.id);
    if (!rec) {
      rejected++;
      continue;
    }
    (rec as Record<string, unknown>)[p.field] = p.value;
    applied++;
  }
  return { records: Array.from(byId.values()), applied, rejected };
}
