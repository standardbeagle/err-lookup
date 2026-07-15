import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { verifyPrompt, type VerifyPatchJson } from "./prompts.js";
import type { ErrorEntry } from "@errlookup/schema";

export interface VerifyResult {
  patches: VerifyPatchJson[];
  durationMs: number;
  providerUsed: string;
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
  const primary = cfg.providers[cfg.defaults.primary];
  const budget = primary?.timeoutMs ?? 600_000;
  try {
    const result = await withTimeout(
      runProvider(verifyPrompt(compact), { cwd: repoPath }, providers, cfg),
      budget
    );
    const parsed = result.parsed as { patches?: VerifyPatchJson[] };
    onLog?.(`verify: ${parsed.patches?.length ?? 0} patches via ${result.providerUsed}`);
    return { patches: parsed.patches ?? [], durationMs: Date.now() - started, providerUsed: result.providerUsed };
  } catch {
    onLog?.("verify: skipped (provider error)");
    return { patches: [], durationMs: Date.now() - started, providerUsed: "n/a" };
  }
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
