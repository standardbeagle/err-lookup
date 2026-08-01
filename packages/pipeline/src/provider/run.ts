import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { ProviderError } from "./types.js";

/** Filename (inside the invocation cwd) where the agent must write its JSON. */
export const OUTPUT_FILENAME = ".errlookup.out.json";

function withOutputInstruction(prompt: string, outputFile: string): string {
  return (
    `${prompt}\n\n` +
    `OUTPUT DELIVERY: Write the final JSON to the file "${outputFile}" ` +
    `(create or overwrite it; the file must contain only the JSON). ` +
    `Do not print the JSON to stdout.`
  );
}

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

  // File-based output handoff: the agent writes its JSON into the invocation
  // cwd (inside the agent's write sandbox); each attempt starts from a clean slate.
  const outputFile = join(opts.cwd, OUTPUT_FILENAME);
  const attemptOpts: InvokeOptions = { ...opts, outputFile };
  const attemptPrompt = withOutputInstruction(prompt, outputFile);
  const clean = () => rmSync(outputFile, { force: true });

  try {
    // Primary: try once, retry once.
    let lastPrimary: ProviderResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      clean();
      const r = await primary.invoke(attemptPrompt, attemptOpts);
      if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: primary.name };
      lastPrimary = r;
    }

    // Fallback (single attempt).
    if (fallbackName && fallbackName !== primaryName) {
      const fallback = providers[fallbackName];
      if (fallback) {
        clean();
        const r = await fallback.invoke(attemptPrompt, attemptOpts);
        if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: fallback.name };
      }
    }

    const failed = lastPrimary ?? { ok: false as const, kind: "empty" as const, error: "no attempt made" };
    throw new ProviderError(failed.kind, failed.error, primaryName);
  } finally {
    clean();
  }
}
