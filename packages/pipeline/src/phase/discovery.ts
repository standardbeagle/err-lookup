import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { DISCOVERY_PROMPT, candidateDiscoveryPrompt, type DiscoveredErrorJson } from "./prompts.js";
import { extractCandidatesAuto, type CandidateSite } from "./candidates.js";

export interface DiscoveryResult {
  errors: DiscoveredErrorJson[];
  raw: string;
  providerUsed: string;
  durationMs: number;
  /** How candidates were sourced: lci / builtin extractor, or agentic scan. */
  mode: "candidates-lci" | "candidates-builtin" | "agentic";
}

const CANDIDATE_BATCH = 80;

function parseErrors(parsed: unknown): DiscoveredErrorJson[] {
  const p = parsed as { errors?: DiscoveredErrorJson[] };
  return Array.isArray(p?.errors) ? p.errors!.filter((e) => e && typeof e.message === "string") : [];
}

/**
 * Phase 1 — Discovery (§4.2.1). Deterministic candidate extraction feeds the
 * model dense classification batches (cheap models judge concrete sites far
 * better than they search, and one message carries ~80 sites). The agentic
 * whole-repo scan runs only when extraction finds nothing (e.g. a language
 * the extractor does not cover). Wrapped in the phase-level watchdog timeout.
 */
export async function runDiscovery(
  repoPath: string,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  onBatch?: (done: number, total: number) => void
): Promise<DiscoveryResult> {
  const started = Date.now();
  const primary = cfg.providers[cfg.phaseProviders?.discovery ?? cfg.defaults.primary];
  const budget = primary?.timeoutMs ?? 600_000;

  const { candidates, backend } = extractCandidatesAuto(repoPath);

  if (candidates.length === 0) {
    const result = await withTimeout(
      runProvider(DISCOVERY_PROMPT, { cwd: repoPath }, providers, cfg, "discovery"),
      budget
    );
    return {
      errors: parseErrors(result.parsed),
      raw: result.raw,
      providerUsed: result.providerUsed,
      durationMs: Date.now() - started,
      mode: "agentic",
    };
  }

  const batches: CandidateSite[][] = [];
  for (let i = 0; i < candidates.length; i += CANDIDATE_BATCH) {
    batches.push(candidates.slice(i, i + CANDIDATE_BATCH));
  }

  const errors: DiscoveredErrorJson[] = [];
  let providerUsed = "";
  let raw = "";
  for (let b = 0; b < batches.length; b++) {
    const result = await withTimeout(
      runProvider(candidateDiscoveryPrompt(batches[b]!), { cwd: repoPath }, providers, cfg, "discovery"),
      budget
    );
    errors.push(...parseErrors(result.parsed));
    providerUsed = result.providerUsed;
    raw = result.raw;
    onBatch?.(b + 1, batches.length);
  }

  return {
    errors,
    raw,
    providerUsed,
    durationMs: Date.now() - started,
    mode: backend === "lci" ? "candidates-lci" : "candidates-builtin",
  };
}
