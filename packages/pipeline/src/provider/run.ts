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

/**
 * Provider error text meaning the account is over its request rate — z.ai
 * surfaces "AI_APICallError: Rate limit reached for requests" through the ACP
 * error channel. An immediate retry spends more of the same limit and keeps
 * the account pinned there, so runProvider pauses before retrying these;
 * other failure kinds (parse, spawn, empty) still retry at once — except a
 * timeout, which is not retried at all.
 */
const RATE_LIMIT_RE = /rate.?limit|too many requests|\b429\b/i;

export const RATE_LIMIT_BACKOFF_MS = 30_000;

export function isRateLimitError(error: string): boolean {
  return RATE_LIMIT_RE.test(error);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * attempt, one rate-limit backoff, and time spent queued on the gate — 4x the
 * configured call timeout (3 x timeout + one 30s backoff fits with room over).
 * A tighter budget (it used to equal the call timeout) fires before retry or
 * fallback ever run, turning ordinary congestion into phase failures.
 */
export function watchdogBudgetMs(
  cfg: ErrlookupConfig,
  phase?: "scope" | "discovery" | "enrichment" | "defense" | "verify" | "review"
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
 * A timeout skips the retry: see the break below.
 *
 * `providers` is the resolved map (name → LlmProvider); the caller wires fixtures
 * in tests and real SpawningProviders in production.
 */
export async function runProvider(
  prompt: string,
  opts: InvokeOptions,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  phase?: "scope" | "discovery" | "enrichment" | "defense" | "verify" | "review",
  sleep: (ms: number) => Promise<void> = realSleep
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
    // Primary: try once, retry once. The backoff sleeps outside any provider
    // invoke, so no throttle-gate slot is held while waiting.
    let lastFailure: Extract<ProviderResult, { ok: false }> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (lastFailure && isRateLimitError(lastFailure.error)) await sleep(RATE_LIMIT_BACKOFF_MS);
      clean();
      const r = await primary.invoke(attemptPrompt, attemptOpts);
      if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: primary.name };
      lastFailure = r;
      // A timeout means the call ran its whole budget and was killed. An
      // identical second attempt spends the same input tokens to be killed
      // again; what fixes an over-large call is the caller splitting its
      // batch, which only happens once this returns. Other kinds (spawn,
      // parse, empty, rate limit) are transient enough to retry in place.
      if (r.kind === "timeout") break;
    }

    // Fallback (single attempt). No backoff here: the fallback is a different
    // provider, so the primary's rate limit does not gate it.
    if (fallbackName && fallbackName !== primaryName) {
      const fallback = providers[fallbackName];
      if (fallback) {
        clean();
        const r = await fallback.invoke(attemptPrompt, attemptOpts);
        if (r.ok) return { parsed: r.parsed, raw: r.raw, providerUsed: fallback.name };
      }
    }

    const failed = lastFailure ?? { ok: false as const, kind: "empty" as const, error: "no attempt made" };
    throw new ProviderError(failed.kind, failed.error, primaryName);
  } finally {
    clean();
  }
}
