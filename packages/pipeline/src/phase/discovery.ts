import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { DISCOVERY_PROMPT, type DiscoveredErrorJson } from "./prompts.js";

export interface DiscoveryResult {
  errors: DiscoveredErrorJson[];
  raw: string;
  providerUsed: string;
  durationMs: number;
}

/** Phase 1 — Discovery (§4.2.1). Wrapped in the phase-level watchdog timeout. */
export async function runDiscovery(
  repoPath: string,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig
): Promise<DiscoveryResult> {
  const started = Date.now();
  const primary = cfg.providers[cfg.defaults.primary];
  const budget = primary?.timeoutMs ?? 600_000;
  const result = await withTimeout(
    runProvider(DISCOVERY_PROMPT, { cwd: repoPath }, providers, cfg),
    budget
  );
  const parsed = result.parsed as { errors?: DiscoveredErrorJson[] };
  const errs = Array.isArray(parsed?.errors) ? parsed.errors!.filter((e) => e && typeof e.message === "string") : [];
  return {
    errors: errs,
    raw: result.raw,
    providerUsed: result.providerUsed,
    durationMs: Date.now() - started,
  };
}
