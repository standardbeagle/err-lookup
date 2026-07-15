import type { Db } from "../db/client.js";
import {
  upsertRepo,
  recordPhase,
  latestPhaseRun,
  replaceErrors,
} from "../db/store.js";
import type { PhaseName } from "@errlookup/schema";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { ProviderError } from "../provider/types.js";
import { runDiscovery } from "./discovery.js";
import { runEnrichment } from "./enrichment.js";
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

  // ----- Phase 2: Enrichment + assemble -----
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
        const { records, rejects } = assemble({ repo, sha, repoPath, discovered, enriched: enr.byIndex });
        replaceErrors(db, repo, records.map(toRow));
        recordPhase(db, {
          repo,
          phase: "enrichment",
          status: "success",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
        });
        log(`phase enrichment: ${records.length} records, ${rejects.length} rejects via ${enr.providerUsed} (${enr.durationMs}ms)`);
        upsertRepo(db, {
          repo,
          status: "analyzed",
          analyzedSha: sha,
          analyzedAt: new Date().toISOString(),
          errorCount: records.length,
        });
        return { errorCount: records.length, rejects, skipped };
      } catch (e) {
        const msg = e instanceof ProviderError ? `[${e.kind}] ${e.message}` : (e as Error).message;
        recordPhase(db, {
          repo,
          phase: "enrichment",
          status: "failed",
          startedAt: started,
          completedAt: Date.now(),
          analyzedSha: sha,
          errorLog: msg,
        });
        upsertRepo(db, { repo, status: "failed", lastError: `enrichment: ${msg}` });
        log(`phase enrichment: FAILED — ${msg}`);
        return { errorCount: 0, rejects: [], skipped };
      }
    }
  }

  // enrichment skipped but discovery produced errors — keep whatever was in DB
  return { errorCount: 0, rejects: [], skipped };
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
