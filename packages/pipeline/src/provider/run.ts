import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { ProviderError } from "./types.js";

export interface RunResult {
  parsed: unknown;
  raw: string;
  /** Which provider actually answered (primary or fallback). */
  providerUsed: string;
}

/**
 * Run a single LLM invocation with retry + fallback (§4.1):
 * primary → (on failure) retry once → (still failing) fallback → record failure.
 *
 * `providers` is the resolved map (name → LlmProvider); the caller wires fixtures
 * in tests and real SpawningProviders in production.
 */
export async function runProvider(
  prompt: string,
  opts: InvokeOptions,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig
): Promise<RunResult> {
  const primaryName = cfg.defaults.primary;
  const fallbackName = cfg.defaults.fallback;
  const primary = providers[primaryName];
  if (!primary) {
    throw new ProviderError("spawn", `primary provider "${primaryName}" not configured`, primaryName);
  }

  // Primary: try once, retry once.
  let lastPrimary: ProviderResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await primary.invoke(prompt, opts);
    if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: primary.name };
    lastPrimary = r;
  }

  // Fallback (single attempt).
  if (fallbackName && fallbackName !== primaryName) {
    const fallback = providers[fallbackName];
    if (fallback) {
      const r = await fallback.invoke(prompt, opts);
      if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: fallback.name };
    }
  }

  const failed = lastPrimary ?? { ok: false as const, kind: "empty" as const, error: "no attempt made" };
  throw new ProviderError(failed.kind, failed.error, primaryName);
}
