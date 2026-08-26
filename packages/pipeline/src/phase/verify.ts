import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs, isQuotaShapedError } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool, chunk } from "../util/pool.js";
import { verifyPrompt, type VerifyPatchJson } from "./prompts.js";
import type { ErrorEntry } from "@errlookup/schema";

export interface VerifyResult {
  patches: VerifyPatchJson[];
  durationMs: number;
  providerUsed: string;
  /** Stub batches (post-split, <10 records) that still failed — abandoned. */
  failedBatches: number;
  /** Records inside those stubs — they go unpatched. */
  failedRecords: number;
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
  // The provider's only job here is filling gaps, so only a record that HAS a
  // gap earns a line in the prompt. Chunking first and keeping every chunk
  // that held one gap carried up to 199 complete records along with it: gaps
  // sit above 10% density in most repos, so nearly every chunk qualified and
  // verify re-sent the whole repo. Filtering first cuts the live corpus's
  // verify input from ~116k records to the ~33k that have a gap.
  // Name each record's gaps outright instead of shipping four booleans per
  // record for the model to re-derive them — the gap set is deterministic here.
  // handlingStrategy covers the defense gap: the old patchable-field list never
  // offered a defense field, so defense-only records were re-sent every round
  // with no way to ever satisfy them.
  const gapped = compact
    .map((r) => ({
      id: r.id,
      message: r.message,
      file: r.file,
      line: r.line,
      needs: [
        ...(r.hasDoc ? [] : ["documentation"]),
        ...(r.hasSolutions ? [] : ["solutions"]),
        ...(r.hasSource ? [] : ["sourceCode"]),
        ...(r.hasDefense ? [] : ["handlingStrategy"]),
      ],
    }))
    .filter((r) => r.needs.length > 0);
  const withGaps = chunk(gapped, verifyBatchSize());
  if (withGaps.length === 0) {
    onLog?.("verify: no gaps — provider calls skipped");
    return { patches: [], durationMs: Date.now() - started, providerUsed: "none", failedBatches: 0, failedRecords: 0 };
  }
  // Budget keyed to the verify-phase provider (it used to read the default
  // primary's timeout while routing the call to the verify provider).
  const budget = watchdogBudgetMs(cfg, "verify");
  let providerUsed = "n/a";
  let failedBatches = 0;
  let failedRecords = 0;

  // A failed batch splits in half and each half tries again — same policy as
  // discovery's classify: what kills a batch is usually its size (an over-long
  // call runs out of watchdog), so smaller calls fit where retry-in-place
  // cannot. Only a stub that still fails abandons its own records.
  const verifyBatch = async (batch: typeof gapped): Promise<VerifyPatchJson[]> => {
    try {
      const result = await withTimeout(
        runProvider(verifyPrompt(batch), { cwd: repoPath }, providers, cfg, "verify"),
        budget
      );
      providerUsed = result.providerUsed;
      const parsed = result.parsed as { patches?: VerifyPatchJson[] };
      return parsed.patches ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A quota-shaped failure is not a size problem: halving the batch just
      // doubles the calls thrown at a spent account (5 dead batches became
      // 130 stubs on 2026-08-25). Abandon whole.
      if (batch.length >= 10 && !isQuotaShapedError(msg)) {
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = [await verifyBatch(batch.slice(0, mid)), await verifyBatch(batch.slice(mid))];
        return [...a, ...b];
      }
      failedBatches++;
      failedRecords += batch.length;
      onLog?.(`verify: batch failed: ${msg.slice(0, 300)}`);
      return [];
    }
  };

  const perBatch = await mapPool(withGaps, cfg.defaults.batchConcurrency, verifyBatch);
  const patches = perBatch.flat();
  onLog?.(
    `verify: ${patches.length} patches over ${withGaps.length} batches via ${providerUsed}` +
      (failedBatches > 0 ? ` (${failedBatches} stub batches abandoned — ${failedRecords} records go unpatched)` : "")
  );
  return { patches, durationMs: Date.now() - started, providerUsed, failedBatches, failedRecords };
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
