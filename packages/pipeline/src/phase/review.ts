/**
 * Popularity-driven quality review (phase "review").
 *
 * Verify (§4.2.5) fills structural gaps repo-wide during a scan; this pass
 * runs on demand against the records behind the site's most-visited pages
 * (scripts/report-top-pages.sh, Search Console) and deep-reviews one record
 * per provider call. Patches reuse the verify applyPatches machinery and are
 * re-validated before anything is written.
 *
 * Caveat, by design: a later rescan of the repo rebuilds its records from the
 * phase outputs and drops review improvements. The review result is persisted
 * in job_history (phase "review"), so improvements are recoverable — re-run
 * the review after a rescan.
 */
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { reviewPrompt, type ReviewResultJson, type VerifyPatchJson } from "./prompts.js";
import { applyPatches } from "./verify.js";
import { validateErrorEntry, type ErrorEntry } from "@errlookup/schema";

export interface ReviewOutcome {
  quality: ReviewResultJson["quality"];
  notes: string;
  /** Patches with the record id attached (the prompt omits it — one record per call). */
  patches: VerifyPatchJson[];
  /** The patched, re-validated record. Equals the input when nothing changed. */
  entry: ErrorEntry;
  providerUsed: string;
  durationMs: number;
}

const QUALITIES = new Set(["good", "improved", "defective"]);

/**
 * Accept a page URL (https://errors.standardbeagle.com/<owner>/<repo>/<slug>/)
 * or a bare `<owner>/<repo>/<slug>` — both name one published record.
 */
export function parseReviewTarget(target: string): { repo: string; slug: string } | null {
  let path = target;
  if (/^https?:\/\//.test(target)) {
    try {
      path = new URL(target).pathname;
    } catch {
      return null;
    }
  }
  const segs = path.replace(/^\/+|\/+$/g, "").split("/");
  if (segs.length !== 3 || segs.some((s) => s.length === 0)) return null;
  return { repo: `${segs[0]}/${segs[1]}`, slug: segs[2]! };
}

export async function runReviewOne(
  entry: ErrorEntry,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  cwd: string,
  onLog?: (msg: string) => void
): Promise<ReviewOutcome> {
  const started = Date.now();
  const result = await withTimeout(
    runProvider(reviewPrompt(entry), { cwd }, providers, cfg, "review"),
    watchdogBudgetMs(cfg, "review")
  );
  const parsed = result.parsed as Partial<ReviewResultJson> | null;
  if (!parsed || typeof parsed !== "object" || !QUALITIES.has(parsed.quality as string)) {
    throw new Error(`review: provider returned no usable verdict for ${entry.repo}/${entry.slug}`);
  }
  const quality = parsed.quality as ReviewResultJson["quality"];
  const notes = typeof parsed.notes === "string" ? parsed.notes : "";
  const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : [];

  // A defective record must not be papered over with patches — it needs a
  // rescan or manual removal, and the verdict says so.
  const patches: VerifyPatchJson[] =
    quality === "defective"
      ? []
      : rawPatches
          .filter((p) => p && typeof p.field === "string")
          .map((p) => ({ id: entry.id, field: p.field as VerifyPatchJson["field"], value: p.value }));

  if (patches.length === 0) {
    return { quality, notes, patches, entry, providerUsed: result.providerUsed, durationMs: Date.now() - started };
  }

  const { records } = applyPatches([entry], patches);
  const v = validateErrorEntry(records[0]);
  if (!v.ok) {
    // Invalid model output must not degrade a live record — reject the whole
    // patch set loudly rather than shipping a half-valid page.
    onLog?.(`review: patches for ${entry.repo}/${entry.slug} failed re-validation — rejected`);
    return {
      quality: "good",
      notes: `patches rejected (re-validation failed): ${notes}`,
      patches: [],
      entry,
      providerUsed: result.providerUsed,
      durationMs: Date.now() - started,
    };
  }
  return { quality, notes, patches, entry: v.value, providerUsed: result.providerUsed, durationMs: Date.now() - started };
}
