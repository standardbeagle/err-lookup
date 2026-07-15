import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { defensePrompt, type DiscoveredErrorJson, type DefenseStrategyJson } from "./prompts.js";

export interface DefenseResult {
  byIndex: Map<number, DefenseStrategyJson>;
  durationMs: number;
  providerUsed: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Phase 3 — Defense (§4.2.3). Batches 10 errors/call. Failed batches are non-fatal. */
export async function runDefense(
  repoPath: string,
  discovered: DiscoveredErrorJson[],
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onBatch?: (batch: number, total: number) => void
): Promise<DefenseResult> {
  const started = Date.now();
  const batches = chunk(discovered, 10);
  const byIndex = new Map<number, DefenseStrategyJson>();
  let lastProvider = "n/a";

  for (let i = 0; i < batches.length; i++) {
    onBatch?.(i + 1, batches.length);
    const batch = batches[i]!;
    const startIndex = i * 10;
    try {
      const primary = cfg.providers[cfg.defaults.primary];
      const budget = primary?.timeoutMs ?? 600_000;
      const result = await withTimeout(
        runProvider(defensePrompt(batch, startIndex), { cwd: repoPath }, providers, cfg),
        budget
      );
      lastProvider = result.providerUsed;
      const parsed = result.parsed as { defenseStrategies?: DefenseStrategyJson[] };
      for (const d of parsed.defenseStrategies ?? []) {
        if (typeof d?.errorIndex === "number") byIndex.set(d.errorIndex, d);
      }
    } catch {
      // batch failed; skip — verify phase flags missing defense
    }
  }

  return { byIndex, durationMs: Date.now() - started, providerUsed: lastProvider };
}
