import type { Db } from "../db/client.js";
import {
  recordPhase,
  latestPhaseRun,
  integrateAnalyzedVersion,
  recordAnalysisFailure,
  getRepo,
} from "../db/store.js";
import type { PhaseName, ErrorEntry } from "@errlookup/schema";
import { validateErrorEntry } from "@errlookup/schema";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { ProviderError } from "../provider/types.js";
import { runDiscovery } from "./discovery.js";
import { runAnalysis } from "./analysis.js";
import { runVerify, applyPatches } from "./verify.js";
import { assemble } from "./assembler.js";
import type { DiscoveredErrorJson, EnrichedErrorJson, DefenseStrategyJson } from "./prompts.js";

export interface RunPhasesOptions {
  db: Db;
  repo: string;
  sha: string;
  repoPath: string;
  providers: Record<string, LlmProvider>;
  cfg: ErrlookupConfig;
  /** Which phases to run (default all available in M2: discovery + enrichment). */
  phases?: Partial<Record<PhaseName, boolean>>;
  force?: boolean;
  onLog?: (msg: string) => void;
}

export interface RunPhasesResult {
  errorCount: number;
  rejects: { message: string; error: string }[];
  skipped: PhaseName[];
  /** Set when a required phase failed and the repo produced no usable result. */
  failed?: string;
  /** Set by analyzeRepo: this run held the machine-wide large-repo slot. The
   *  scan uses it to escalate a resource failure straight to an exclusive
   *  retry — a run that already had the slot gains nothing from level 1. */
  heldLargeSlot?: boolean;
}

const ALL_M2_PHASES: PhaseName[] = ["discovery", "enrichment"];

function phaseDone(db: Db, repo: string, sha: string, phase: PhaseName, force?: boolean): boolean {
  if (force) return false;
  return latestPhaseRun(db, repo, sha, phase)?.status === "success";
}

/** Parse a persisted Map<number, T> phase result (stored as [index, value][]). */
function parseIndexedMap<T>(result: string | null | undefined): Map<number, T> | null {
  if (!result) return null;
  try {
    const arr = JSON.parse(result) as [number, T][];
    return Array.isArray(arr) ? new Map(arr) : null;
  } catch {
    return null;
  }
}

/** Parse + revalidate the persisted post-patch records of a verify run. */
function parseVerifyResult(result: string | null | undefined): ErrorEntry[] | null {
  if (!result) return null;
  try {
    const arr = JSON.parse(result) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const valid = arr
      .map((r) => validateErrorEntry(r))
      .filter((r): r is { ok: true; value: ErrorEntry } => r.ok)
      .map((r) => r.value);
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Orchestrate discovery → enrichment → assemble for one repo, with idempotent
 * resume per phase (§4.5) and job_history instrumentation (§4.4). Records the
 * repository row and final error count.
 */
export async function runPhases(opts: RunPhasesOptions): Promise<RunPhasesResult> {
  const { db, repo, sha, repoPath, providers, cfg } = opts;
  const log = opts.onLog ?? (() => {});
  const wanted = (phase: PhaseName) => opts.phases?.[phase] ?? true;
  const skipped: PhaseName[] = [];

  // ----- Phase 1: Discovery -----
  let discovered: DiscoveredErrorJson[] = [];
  if (wanted("discovery")) {
    if (phaseDone(db, repo, sha, "discovery", opts.force)) {
      const run = latestPhaseRun(db, repo, sha, "discovery");
      try {
        discovered = JSON.parse(run?.result ?? "[]") as DiscoveredErrorJson[];
      } catch {
        discovered = [];
      }
      skipped.push("discovery");
      log(`phase discovery: skipped (already succeeded for ${sha.slice(0, 8)})`);
    } else {
      const started = Date.now();
      // In-flight state lives in job_history only: the repository row keeps
      // pointing at the last published version until the new one is complete,
      // so a re-scan (or its failure) never knocks a repo out of the export.
      recordPhase(db, { repo, phase: "discovery", status: "running", startedAt: started, analyzedSha: sha });
      try {
        const r = await runDiscovery(repoPath, providers, cfg, (b, t) =>
          log(`phase discovery: batch ${b}/${t}`)
        );
        discovered = r.errors;
        recordPhase(db, {
          repo,
          phase: "discovery",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify(discovered),
        });
        log(`phase discovery: ${discovered.length} errors via ${r.providerUsed} [${r.mode}] (${r.durationMs}ms)`);
      } catch (e) {
        const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
        recordPhase(db, {
          repo,
          phase: "discovery",
          status: "failed",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          errorLog: msg,
        });
        recordAnalysisFailure(db, repo, `discovery: ${msg}`);
        log(`phase discovery: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped, failed: `discovery: ${msg}` };
      }
    }
  }

  if (discovered.length === 0) {
    integrateAnalyzedVersion(db, repo, sha, []);
    log("phase discovery: no errors found; repo marked analyzed");
    return { errorCount: 0, rejects: [], skipped };
  }

  // Fully analyzed at this SHA with enrichment recorded — nothing to redo, and
  // reassembling would clobber verify-phase patches already in the errors table.
  const repoRow = getRepo(db, repo);
  if (
    !opts.force &&
    (repoRow?.status === "analyzed" || repoRow?.status === "exported") &&
    repoRow.analyzedSha === sha &&
    phaseDone(db, repo, sha, "enrichment")
  ) {
    skipped.push("enrichment");
    log(`done: ${repoRow.errorCount ?? 0} records (already analyzed at ${sha.slice(0, 8)})`);
    return { errorCount: repoRow.errorCount ?? 0, rejects: [], skipped };
  }

  // ----- Phases 2+3: Enrichment + Defense (one fused pass) -----
  // Both phases ask about the same errors at the same file:line, so they share
  // a call per batch. Their DB rows stay separate: resume, per-phase skip and
  // the `--phases` selector all keep working, and a repo that already has one
  // of them persisted only pays for the other.
  let enrichedMap = new Map<number, EnrichedErrorJson>();
  let defenseMap = new Map<number, DefenseStrategyJson>();
  const need = { enrichment: false, defense: false };

  if (wanted("enrichment")) {
    const persisted = phaseDone(db, repo, sha, "enrichment", opts.force)
      ? parseIndexedMap<EnrichedErrorJson>(latestPhaseRun(db, repo, sha, "enrichment")?.result)
      : null;
    if (persisted) {
      enrichedMap = persisted;
      skipped.push("enrichment");
      log(`phase enrichment: skipped (already succeeded for ${sha.slice(0, 8)}; reusing persisted output)`);
    } else {
      need.enrichment = true;
    }
  }

  if (wanted("defense")) {
    const persisted = phaseDone(db, repo, sha, "defense", opts.force)
      ? parseIndexedMap<DefenseStrategyJson>(latestPhaseRun(db, repo, sha, "defense")?.result)
      : null;
    if (persisted) {
      defenseMap = persisted;
      skipped.push("defense");
      log(`phase defense: skipped (already succeeded for ${sha.slice(0, 8)}; reusing persisted output)`);
    } else {
      need.defense = true;
    }
  }

  if (need.enrichment || need.defense) {
    const started = Date.now();
    try {
      const res = await runAnalysis(repoPath, discovered, providers, cfg, need, (d, t) =>
        log(`phase analysis: ${d}/${t} batches`)
      );
      if (need.enrichment) {
        enrichedMap = res.enrichedByIndex;
        recordPhase(db, {
          repo,
          phase: "enrichment",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify([...enrichedMap.entries()]),
        });
        log(`phase enrichment: ${enrichedMap.size}/${discovered.length} enriched via ${res.providerUsed}`);
      }
      if (need.defense) {
        defenseMap = res.defenseByIndex;
        recordPhase(db, {
          repo,
          phase: "defense",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify([...defenseMap.entries()]),
        });
        log(`phase defense: ${defenseMap.size}/${discovered.length} strategies via ${res.providerUsed}`);
      }
      log(
        `phase analysis: ${res.batches} batches, ${res.failedBatches} failed via ${res.providerUsed} (${res.durationMs}ms)`
      );
    } catch (e) {
      // Only a whole-phase fault reaches here — individual batch failures are
      // absorbed inside runAnalysis. Enrichment is required, defense is not.
      const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
      if (need.enrichment) {
        recordPhase(db, { repo, phase: "enrichment", status: "failed", startedAt: started, completedAt: Date.now(), analyzedSha: sha, errorLog: msg });
      }
      if (need.defense) {
        recordPhase(db, { repo, phase: "defense", status: "failed", startedAt: started, completedAt: Date.now(), analyzedSha: sha, errorLog: msg });
      }
      if (need.enrichment) {
        recordAnalysisFailure(db, repo, `enrichment: ${msg}`);
        log(`phase enrichment: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped, failed: `enrichment: ${msg}` };
      }
      log(`phase defense: FAILED — ${msg} (continuing, defense is optional)`);
    }
  }

  // ----- Assemble -----
  // Deterministic from the persisted phase outputs above; nothing is written to
  // the errors table until the whole version (verify included) is complete.
  const assembled = assemble({ repo, sha, repoPath, discovered, enriched: enrichedMap, defense: defenseMap });

  // ----- Phase 5: Verify (patch loop, max 2 rounds) -----
  if (wanted("verify") && assembled.records.length > 0) {
    if (phaseDone(db, repo, sha, "verify", opts.force)) {
      // Reuse the persisted post-patch records — reassembly alone would silently
      // drop the verify patches on resume. Older verify rows predate the result
      // payload; for those the reassembled records are the best available.
      const persisted = parseVerifyResult(latestPhaseRun(db, repo, sha, "verify")?.result);
      if (persisted) assembled.records = persisted;
      skipped.push("verify");
      log(`phase verify: skipped (already succeeded for ${sha.slice(0, 8)})`);
    } else {
      const started = Date.now();
      let records = assembled.records;
      for (let round = 0; round < 2; round++) {
        const v = await runVerify(repoPath, records, providers, cfg, (m) => log(`phase verify: ${m}`));
        if (v.patches.length === 0) break;
        const { records: patched, applied } = applyPatches(records, v.patches);
        // re-validate every patched record; keep only valid
        const revalidated = patched
          .map((r) => validateErrorEntry(r))
          .filter((r): r is { ok: true; value: ErrorEntry } => r.ok)
          .map((r) => r.value);
        records = revalidated;
        log(`phase verify: round ${round + 1} applied ${applied} patches → ${records.length} valid records`);
      }
      assembled.records = records;
      recordPhase(db, {
        repo,
        phase: "verify",
        status: "success",
        startedAt: started,
        completedAt: Date.now(),
        analyzedSha: sha,
        result: JSON.stringify(records),
      });
    }
  }

  integrateAnalyzedVersion(db, repo, sha, assembled.records.map(toRow));
  log(`done: ${assembled.records.length} records (${assembled.rejects.length} rejects)`);
  return { errorCount: assembled.records.length, rejects: assembled.rejects, skipped };
}

/** Map a validated ErrorEntry to a DB row (arrays stored as JSON text). */
function toRow(e: import("@errlookup/schema").ErrorEntry) {
  return {
    id: e.id,
    repo: e.repo,
    slug: e.slug,
    errorCode: e.errorCode,
    errorMessage: e.errorMessage,
    messagePattern: e.messagePattern,
    errorType: e.errorType,
    errorClass: e.errorClass,
    httpStatus: e.httpStatus,
    severity: e.severity,
    filePath: e.filePath,
    lineNumber: e.lineNumber,
    sourceCode: e.sourceCode,
    sourceCodeStart: e.sourceCodeStart,
    sourceCodeEnd: e.sourceCodeEnd,
    githubUrl: e.githubUrl,
    documentation: e.documentation,
    triggerScenarios: e.triggerScenarios,
    commonSituations: e.commonSituations,
    solutions: e.solutions,
    exampleFix: e.exampleFix,
    handlingStrategy: e.handlingStrategy,
    validationCode: e.validationCode,
    typeGuard: e.typeGuard,
    tryCatchPattern: e.tryCatchPattern,
    preventionTips: e.preventionTips,
    tags: e.tags,
    analyzedSha: e.analyzedSha,
    analyzedAt: e.analyzedAt,
    schemaVersion: e.schemaVersion,
  };
}

export { ALL_M2_PHASES };
