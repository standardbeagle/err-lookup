import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { ProviderError } from "./types.js";

/** Prefix for the file (inside the invocation cwd) where the agent must write its JSON. */
export const OUTPUT_PREFIX = ".errlookup.out";

let outputSeq = 0;

/**
 * Per-invocation output filename. Concurrent batches of the same phase share the
 * clone dir as their cwd, so a fixed name would let one call read — or its
 * cleanup delete — another call's JSON. pid + sequence is unique across both
 * concurrent calls in this process and overlapping runs on the same machine.
 */
function nextOutputFile(cwd: string): string {
  return join(cwd, `${OUTPUT_PREFIX}.${process.pid}.${outputSeq++}.json`);
}

function withOutputInstruction(prompt: string, outputFile: string): string {
  return (
    `${prompt}\n\n` +
    `OUTPUT DELIVERY: Write the final JSON to the file "${outputFile}" ` +
    `(create or overwrite it; the file must contain only the JSON). ` +
    `Do not print the JSON to stdout.`
  );
}

/**
 * Phase-level watchdog budget for one runProvider call. The real per-call
 * timeout lives inside each provider and starts AFTER the shared throttle gate
 * is acquired, so the outer net must cover two primary attempts, one fallback
 * attempt, and time spent queued on the gate — 4x the configured call timeout.
 * A tighter budget (it used to equal the call timeout) fires before retry or
 * fallback ever run, turning ordinary congestion into phase failures.
 */
export function watchdogBudgetMs(
  cfg: ErrlookupConfig,
  phase?: "discovery" | "enrichment" | "defense" | "verify"
): number {
  const primaryName = (phase && cfg.phaseProviders?.[phase]) || cfg.defaults.primary;
  return (cfg.providers[primaryName]?.timeoutMs ?? 600_000) * 4;
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
  cfg: ErrlookupConfig,
  phase?: "discovery" | "enrichment" | "defense" | "verify"
): Promise<RunResult> {
  const primaryName = (phase && cfg.phaseProviders?.[phase]) || cfg.defaults.primary;
  const fallbackName = cfg.defaults.fallback;
  const primary = providers[primaryName];
  if (!primary) {
    throw new ProviderError("spawn", `primary provider "${primaryName}" not configured`, primaryName);
  }

  // File-based output handoff: the agent writes its JSON into the invocation
  // cwd (inside the agent's write sandbox); each attempt starts from a clean slate.
  const outputFile = nextOutputFile(opts.cwd);
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
