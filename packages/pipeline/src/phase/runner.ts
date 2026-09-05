import type { Db } from "../db/client.js";
import { rowToErrorEntry } from "../exporter/index.js";
import {
  recordPhase,
  latestPhaseRun,
  integrateAnalyzedVersion,
  recordAnalysisFailure,
  getRepo,
  errorsForRepo,
} from "../db/store.js";
import type { ErrorRow } from "../db/schema.js";
import { computeErrorId } from "../util/ids.js";
import { extractSourceRegion, githubPermalink } from "../util/source.js";
import { planRescan, candidateInReview, type FileDiff, type RescanPlan } from "./delta.js";
import type { PhaseName, ErrorEntry } from "@errlookup/schema";
import { validateErrorEntry } from "@errlookup/schema";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { ProviderError } from "../provider/types.js";
import { phaseBatchCheckpoint, clearPhaseBatches } from "../db/checkpoints.js";
import { runDiscovery } from "./discovery.js";
import { runScope } from "./scope.js";
import type { ScanScope } from "./candidates.js";
import { runAnalysis } from "./analysis.js";
import { runVerify, applyPatches, missingCore } from "./verify.js";
import { collectCallFacts } from "./callgraph.js";
import { promptFamilies, tagIndexFor } from "./tag-vocabulary.js";
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
  /** Incremental rescan: the diff from the published version to `sha`. When
   *  set, only the changed hunks are reviewed and everything else carries
   *  over from the published records (see phase/delta.ts). */
  delta?: RescanDelta;
}

export interface RescanDelta {
  baseSha: string;
  /** Source-relevant files only (extension + static exclusions applied). */
  files: FileDiff[];
}

export interface RunPhasesResult {
  errorCount: number;
  rejects: { message: string; error: string }[];
  skipped: PhaseName[];
  /** Set when a required phase failed and the repo produced no usable result. */
  failed?: string;
  /** Incremental rescan accounting — absent on a full analysis. */
  incremental?: { carriedOver: number; remapped: number; dropped: number; reused: number; fresh: number };
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

  // Incremental rescan plan: which published records survive the diff as-is,
  // which move, which are gone, and which files discovery must review. Built
  // once here from the published rows — integrate is the only writer of
  // those, so the plan is stable across a resume of this same HEAD.
  const plan: RescanPlan | null = opts.delta
    ? planRescan(errorsForRepo(db, repo), opts.delta.files, () => true)
    : null;
  if (plan) {
    log(
      `incremental from ${opts.delta!.baseSha.slice(0, 8)}: ${plan.reviewFiles.size} files to review, ` +
        `${plan.carryOver.length} records carried over, ${plan.remapped.length} re-anchored, ${plan.dropped.length} dropped`
    );
  }

  // ----- Phase 0: Scope -----
  // LLM-derived per-repo scan scope (include-roots + exclude-dirs on top of
  // the static floor). Runs only when discovery will actually run — a resumed
  // discovery already baked its scope into the persisted result.
  let scope: ScanScope | undefined;
  const discoveryNeeded = wanted("discovery") && !phaseDone(db, repo, sha, "discovery", opts.force);
  const baseScope = plan ? latestPhaseRun(db, repo, opts.delta!.baseSha, "scope") : undefined;
  if (discoveryNeeded && plan && baseScope?.status === "success" && baseScope.result) {
    // The published version's scope still describes this repo's layout; a
    // hunk-level review does not need a fresh provider call to re-decide it.
    try {
      scope = JSON.parse(baseScope.result) as ScanScope;
      skipped.push("scope");
      log(`phase scope: reused from ${opts.delta!.baseSha.slice(0, 8)}`);
    } catch {
      scope = undefined;
    }
  } else if (discoveryNeeded && wanted("scope") && process.env.ERRLOOKUP_SCOPE !== "off") {
    if (phaseDone(db, repo, sha, "scope", opts.force)) {
      try {
        scope = JSON.parse(latestPhaseRun(db, repo, sha, "scope")?.result ?? "") as ScanScope;
      } catch {
        scope = undefined;
      }
      skipped.push("scope");
      log(`phase scope: skipped (already succeeded for ${sha.slice(0, 8)})`);
    } else {
      const started = Date.now();
      recordPhase(db, { repo, phase: "scope", status: "running", startedAt: started, analyzedSha: sha });
      try {
        const r = await runScope(repoPath, repo, providers, cfg, (m) => log(`phase scope: ${m}`));
        scope = r.scope;
        recordPhase(db, {
          repo,
          phase: "scope",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify(scope),
        });
        log(`phase scope: ${r.mode} via ${r.providerUsed} (${r.durationMs}ms)`);
      } catch (e) {
        const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
        recordPhase(db, {
          repo,
          phase: "scope",
          status: "failed",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          errorLog: msg,
        });
        recordAnalysisFailure(db, repo, `scope: ${msg}`);
        log(`phase scope: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped, failed: `scope: ${msg}` };
      }
    }
  }

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
        const r = await runDiscovery(
          repoPath,
          providers,
          cfg,
          (b, t) => log(`phase discovery: batch ${b}/${t}`),
          (m) => log(`phase discovery: ${m}`),
          scope,
          phaseBatchCheckpoint(db, repo, sha, "discovery"),
          plan ? candidateInReview(plan.reviewFiles) : undefined
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
        clearPhaseBatches(db, repo, "discovery");
        if (r.skippedCandidates > 0) {
          log(`phase discovery: ${r.skippedCandidates} candidates abandoned after batch-splitting retries`);
        }
        // Every candidate abandoned and nothing found is a processing failure
        // wearing the costume of a clean result. Publishing it says "this repo
        // has no errors", which is how a provider outage — or a spent quota —
        // used to take a repo's whole page set down.
        if (discovered.length === 0 && r.skippedCandidates > 0) {
          const msg = `every candidate batch failed (${r.skippedCandidates} candidates abandoned)`;
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

  if (discovered.length === 0 && plan) {
    const kept = keptRows(plan, repo, sha, repoPath);
    integrateAnalyzedVersion(db, repo, sha, kept);
    log(`phase discovery: no errors in the changed hunks; ${kept.length} published records carried to ${sha.slice(0, 8)}`);
    return {
      errorCount: kept.length,
      rejects: [],
      skipped,
      incremental: { carriedOver: plan.carryOver.length, remapped: plan.remapped.length, dropped: plan.dropped.length, reused: 0, fresh: 0 },
    };
  }
  // Verify-only run (`reverify`): discovery is switched off, so the published
  // records ARE the input — the point is to patch their gaps without paying
  // for discovery, enrichment and defense again.
  const verifyOnly = !wanted("discovery") && wanted("verify");
  const publishedRecords = verifyOnly ? errorsForRepo(db, repo).map(rowToErrorEntry) : [];
  if (verifyOnly && publishedRecords.length > 0) {
    log(`verify-only: ${publishedRecords.length} published records loaded for patching`);
  }

  if (discovered.length === 0 && publishedRecords.length === 0) {
    integrateAnalyzedVersion(db, repo, sha, []);
    log("phase discovery: no errors found; repo marked analyzed");
    return { errorCount: 0, rejects: [], skipped };
  }

  // Incremental: a reviewed site whose identity (message/code/file) matches a
  // published record is the same error — its documentation and defense carry
  // over and only its location is re-derived. Only genuinely new identities
  // go to the provider. `fresh` is the sub-list analysis runs over; indices
  // map back to `discovered` for assembly.
  const reuse = new Map<number, ErrorRow>();
  const freshIdx: number[] = [];
  if (plan) {
    const publishedById = new Map<string, ErrorRow>();
    for (const r of [...plan.carryOver, ...plan.remapped.map((m) => m.row), ...plan.dropped]) publishedById.set(r.id, r);
    discovered.forEach((d, i) => {
      const id = computeErrorId({ repo, errorCode: d.code ?? null, errorMessage: d.message, filePath: d.file ?? "unknown" });
      const prior = publishedById.get(id);
      if (prior) reuse.set(i, prior);
      else freshIdx.push(i);
    });
    log(`incremental: ${discovered.length} reviewed sites — ${reuse.size} known identities reused, ${freshIdx.length} new`);
  }
  const fresh = plan ? freshIdx.map((i) => discovered[i]!) : discovered;

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

  if ((need.enrichment || need.defense) && fresh.length > 0) {
    const started = Date.now();
    try {
      const res = await runAnalysis(
        repoPath,
        fresh,
        providers,
        cfg,
        need,
        (d, t) => log(`phase analysis: ${d}/${t} batches`),
        (m) => log(`phase analysis: ${m}`),
        phaseBatchCheckpoint(db, repo, sha, "analysis"),
        promptFamilies(db)
      );
      // Analysis indexed the `fresh` sub-list; assembly indexes `discovered`.
      const toDiscoveredIndex = <T>(m: Map<number, T>): Map<number, T> =>
        plan ? new Map([...m.entries()].map(([k, v]) => [freshIdx[k]!, v])) : m;
      if (need.enrichment) {
        enrichedMap = toDiscoveredIndex(res.enrichedByIndex);
        recordPhase(db, {
          repo,
          phase: "enrichment",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify([...enrichedMap.entries()]),
        });
        log(`phase enrichment: ${enrichedMap.size}/${fresh.length} enriched via ${res.providerUsed}`);
      }
      if (need.defense) {
        defenseMap = toDiscoveredIndex(res.defenseByIndex);
        recordPhase(db, {
          repo,
          phase: "defense",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          result: JSON.stringify([...defenseMap.entries()]),
        });
        log(`phase defense: ${defenseMap.size}/${fresh.length} strategies via ${res.providerUsed}`);
      }
      log(
        `phase analysis: ${res.batches} batches, ${res.failedBatches} failed via ${res.providerUsed} (${res.durationMs}ms)`
      );
      clearPhaseBatches(db, repo, "analysis");
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
  let kept: Omit<ErrorRow, "updatedAt">[] = [];
  if (plan) {
    for (const [i, prior] of reuse) {
      enrichedMap.set(i, enrichmentFromRow(i, prior));
      defenseMap.set(i, defenseFromRow(i, prior));
    }
    kept = keptRows(plan, repo, sha, repoPath);
  }
  const assembled = verifyOnly
    ? { records: publishedRecords, rejects: [] }
    : assemble({
        repo,
        sha,
        repoPath,
        discovered,
        enriched: enrichedMap,
        defense: defenseMap,
        reservedIds: new Set(kept.map((r) => r.id)),
        reservedSlugs: new Set(kept.map((r) => r.slug)),
        // Every slug currently published for the repo: integrate never deletes
        // survivors, so a fresh record deriving a survivor's slug would hit
        // the unique (repo, slug) index and fail the whole integration.
        existingSlugOwners: new Map(errorsForRepo(db, repo).map((r) => [r.slug, r.id])),
        // Fold a coined family name onto the established spelling at the
        // write boundary — the prompt asks for reuse, this is what enforces it.
        tagIndex: tagIndexFor(db),
      });


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
      // lci context for the records verify will actually write prose for:
      // collected once here (the index is warm from analysis; a verify-only
      // run pays its own readiness gate) and reused by every round and the
      // escalation. Facts are optional by contract — no lci, no facts, and
      // the prompt carries the stored source alone.
      const coreSites = records
        .filter((r) => missingCore(r).length > 0 && r.lineNumber != null)
        .map((r) => ({ file: r.filePath, line: r.lineNumber! }));
      // Same config flag as analysis: with call-facts off there is no lci
      // index to consult, and paying its readiness gate here anyway is what
      // pushed every fixture-provider scan past its test timeout.
      const verifyFacts =
        cfg.defaults.callFacts && coreSites.length > 0
          ? await collectCallFacts(repoPath, coreSites, (m) => log(`phase verify: ${m}`))
          : undefined;
      // Round 1 sees every record; round 2 only the ones round 1 patched, to
      // confirm the patches closed their gaps. A record the model declined to
      // patch would be re-asked the identical question — pure token spend.
      let candidates = records;
      for (let round = 0; round < 2; round++) {
        const v = await runVerify(repoPath, candidates, providers, cfg, (m) => log(`phase verify: ${m}`), "verify", verifyFacts);
        if (v.patches.length === 0) break;
        const patchedIds = new Set(v.patches.map((p) => p.id));
        // applyPatches validates per patch and reverts the bad ones — records
        // are never dropped and never re-filtered here (record-level filtering
        // is what threw away tensorflow/models' whole patch set on 2026-09-01).
        const { records: patched, applied, rejected } = applyPatches(records, v.patches);
        records = patched;
        candidates = records.filter((r) => patchedIds.has(r.id));
        log(
          `phase verify: round ${round + 1} applied ${applied} patches` +
            (rejected > 0 ? ` (${rejected} invalid patches reverted)` : "")
        );
      }
      // A record still missing the two answers its page exists to give — what
      // the error means and how to handle it — gets one pass on a second
      // model (phase-providers verify-escalate) before we accept the gap. If
      // that model cannot answer either, the record is raised as a data bug:
      // a loud log line the drain's ntfy summary counts, while the site keeps
      // the page noindexed until something real fills it.
      let unresolved = records.filter((r) => missingCore(r).length > 0);
      const verifyProvider = cfg.phaseProviders?.verify ?? cfg.defaults.primary;
      const escalateProvider = cfg.phaseProviders?.["verify-escalate"];
      if (unresolved.length > 0 && escalateProvider && escalateProvider !== verifyProvider) {
        log(`phase verify: escalating ${unresolved.length} unanswered records to ${escalateProvider}`);
        const v = await runVerify(
          repoPath,
          unresolved,
          providers,
          cfg,
          (m) => log(`phase verify-escalate: ${m}`),
          "verify-escalate",
          verifyFacts
        );
        if (v.patches.length > 0) {
          const { records: patched, applied, rejected } = applyPatches(records, v.patches);
          records = patched;
          log(
            `phase verify-escalate: applied ${applied} patches` +
              (rejected > 0 ? ` (${rejected} invalid patches reverted)` : "")
          );
        }
        unresolved = records.filter((r) => missingCore(r).length > 0);
      }
      if (unresolved.length > 0) {
        log(
          `phase verify: ${unresolved.length} records UNRESOLVED — no model could say what they mean or how to handle them` +
            ` (e.g. ${unresolved.slice(0, 3).map((r) => r.slug).join(", ")}); raised as data bugs`
        );
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

  const rows = [...kept, ...assembled.records.map(toRow)];
  integrateAnalyzedVersion(db, repo, sha, rows);
  log(`done: ${rows.length} records (${assembled.rejects.length} rejects)`);
  return {
    errorCount: rows.length,
    rejects: assembled.rejects,
    skipped,
    ...(plan
      ? {
          incremental: {
            carriedOver: plan.carryOver.length,
            remapped: plan.remapped.length,
            dropped: plan.dropped.length,
            reused: reuse.size,
            fresh: fresh.length,
          },
        }
      : {}),
  };
}

/**
 * The rows an incremental rescan keeps without a provider call: untouched
 * files verbatim, and records in modified files re-anchored to where their
 * line moved — source region and permalink re-derived from the HEAD checkout
 * so the page shows the code as it is now.
 */
function keptRows(plan: RescanPlan, repo: string, sha: string, repoPath: string): Omit<ErrorRow, "updatedAt">[] {
  const strip = ({ updatedAt: _u, ...r }: ErrorRow): Omit<ErrorRow, "updatedAt"> => r;
  const remapped = plan.remapped.map(({ row, newLine }) => {
    const region = extractSourceRegion(repoPath, row.filePath, newLine);
    return strip({
      ...row,
      lineNumber: newLine,
      sourceCode: region?.sourceCode ?? row.sourceCode,
      sourceCodeStart: region?.start ?? null,
      sourceCodeEnd: region?.end ?? null,
      githubUrl: githubPermalink(repo, sha, row.filePath, region?.start ?? newLine, region?.end ?? null),
      analyzedSha: sha,
    });
  });
  return [...plan.carryOver.map(strip), ...remapped];
}

function enrichmentFromRow(errorIndex: number, r: ErrorRow): EnrichedErrorJson {
  return {
    errorIndex,
    documentation: r.documentation ?? "",
    triggerScenarios: r.triggerScenarios ?? "",
    commonSituations: r.commonSituations ?? "",
    solutions: r.solutions ?? [],
    exampleFix: r.exampleFix,
    severity: (r.severity as EnrichedErrorJson["severity"]) ?? "error",
    tags: r.tags ?? [],
    backgroundTag: r.backgroundTag,
  };
}

function defenseFromRow(errorIndex: number, r: ErrorRow): DefenseStrategyJson {
  return {
    errorIndex,
    handlingStrategy: (r.handlingStrategy as DefenseStrategyJson["handlingStrategy"]) ?? "try-catch",
    validationCode: r.validationCode,
    typeGuard: r.typeGuard,
    tryCatchPattern: r.tryCatchPattern,
    preventionTips: r.preventionTips ?? [],
  };
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
    backgroundTag: e.backgroundTag,
    analyzedSha: e.analyzedSha,
    analyzedAt: e.analyzedAt,
    schemaVersion: e.schemaVersion,
  };
}

export { ALL_M2_PHASES };
