import type { Db } from "../db/client.js";
import {
  upsertRepo,
  recordPhase,
  latestPhaseRun,
  replaceErrors,
  getRepo,
} from "../db/store.js";
import type { PhaseName, ErrorEntry } from "@errlookup/schema";
import { validateErrorEntry } from "@errlookup/schema";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { ProviderError } from "../provider/types.js";
import { runDiscovery } from "./discovery.js";
import { runEnrichment } from "./enrichment.js";
import { runDefense } from "./defense.js";
import { runVerify, applyPatches } from "./verify.js";
import { assemble } from "./assembler.js";
import type { DiscoveredErrorJson } from "./prompts.js";

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
}

const ALL_M2_PHASES: PhaseName[] = ["discovery", "enrichment"];

function phaseDone(db: Db, repo: string, sha: string, phase: PhaseName, force?: boolean): boolean {
  if (force) return false;
  return latestPhaseRun(db, repo, sha, phase)?.status === "success";
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
      upsertRepo(db, { repo, status: "analyzing", analyzedSha: sha });
      recordPhase(db, { repo, phase: "discovery", status: "running", startedAt: started, analyzedSha: sha });
      try {
        const r = await runDiscovery(repoPath, providers, cfg);
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
        log(`phase discovery: ${discovered.length} errors via ${r.providerUsed} (${r.durationMs}ms)`);
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
        upsertRepo(db, { repo, status: "failed", lastError: `discovery: ${msg}` });
        log(`phase discovery: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped };
      }
    }
  }

  if (discovered.length === 0) {
    replaceErrors(db, repo, []);
    upsertRepo(db, {
      repo,
      status: "analyzed",
      analyzedSha: sha,
      analyzedAt: new Date().toISOString(),
      errorCount: 0,
    });
    log("phase discovery: no errors found; repo marked analyzed");
    return { errorCount: 0, rejects: [], skipped };
  }

  // ----- Phase 2: Enrichment -----
  let enrichedMap = new Map<number, import("./prompts.js").EnrichedErrorJson>();
  if (wanted("enrichment")) {
    if (phaseDone(db, repo, sha, "enrichment", opts.force)) {
      skipped.push("enrichment");
      log(`phase enrichment: skipped (already succeeded for ${sha.slice(0, 8)})`);
    } else {
      const started = Date.now();
      try {
        const enr = await runEnrichment(repoPath, discovered, providers, cfg, (b, t) =>
          log(`phase enrichment: batch ${b}/${t}`)
        );
        enrichedMap = enr.byIndex;
        recordPhase(db, {
          repo,
          phase: "enrichment",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
        });
        log(`phase enrichment: ${enrichedMap.size}/${discovered.length} enriched via ${enr.providerUsed} (${enr.durationMs}ms)`);
      } catch (e) {
        const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
        recordPhase(db, { repo, phase: "enrichment", status: "failed", startedAt: started, completedAt: Date.now(), analyzedSha: sha, errorLog: msg });
        upsertRepo(db, { repo, status: "failed", lastError: `enrichment: ${msg}` });
        log(`phase enrichment: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped };
      }
    }
  }

  // ----- Phase 3: Defense -----
  let defenseMap = new Map<number, import("./prompts.js").DefenseStrategyJson>();
  if (wanted("defense") && !skipped.includes("enrichment")) {
    if (phaseDone(db, repo, sha, "defense", opts.force)) {
      skipped.push("defense");
      log(`phase defense: skipped (already succeeded for ${sha.slice(0, 8)})`);
    } else {
      const started = Date.now();
      try {
        const def = await runDefense(repoPath, discovered, providers, cfg, (b, t) =>
          log(`phase defense: batch ${b}/${t}`)
        );
        defenseMap = def.byIndex;
        recordPhase(db, { repo, phase: "defense", status: "success", startedAt: started, completedAt: Date.now(), analyzedSha: sha });
        log(`phase defense: ${defenseMap.size}/${discovered.length} strategies via ${def.providerUsed} (${def.durationMs}ms)`);
      } catch (e) {
        const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
        recordPhase(db, { repo, phase: "defense", status: "failed", startedAt: started, completedAt: Date.now(), analyzedSha: sha, errorLog: msg });
        log(`phase defense: FAILED — ${msg} (continuing, defense is optional)`);
      }
    }
  }

  // If enrichment was skipped this run (already succeeded before), the errors
  // table already holds the full records — don't reassemble/clobber them.
  if (skipped.includes("enrichment")) {
    const existing = getRepo(db, repo);
    log(`done: ${existing?.errorCount ?? 0} records (enrichment previously completed)`);
    return { errorCount: existing?.errorCount ?? 0, rejects: [], skipped };
  }

  // ----- Assemble + write -----
  const assembled = assemble({ repo, sha, repoPath, discovered, enriched: enrichedMap, defense: defenseMap });
  replaceErrors(db, repo, assembled.records.map(toRow));

  // ----- Phase 5: Verify (patch loop, max 2 rounds) -----
  if (wanted("verify") && assembled.records.length > 0) {
    if (phaseDone(db, repo, sha, "verify", opts.force)) {
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
      replaceErrors(db, repo, records.map(toRow));
      assembled.records = records;
      recordPhase(db, { repo, phase: "verify", status: "success", startedAt: started, completedAt: Date.now(), analyzedSha: sha });
    }
  }

  upsertRepo(db, {
    repo,
    status: "analyzed",
    analyzedSha: sha,
    analyzedAt: new Date().toISOString(),
    errorCount: assembled.records.length,
  });
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
