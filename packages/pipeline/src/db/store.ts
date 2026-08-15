import { eq, desc, and } from "drizzle-orm";
import { tx, type Db } from "./client.js";
import { chunk } from "../util/pool.js";
import { repositories, errors, jobHistory, type ErrorRow, type RepositoryRow } from "./schema.js";
import type { PhaseName } from "@errlookup/schema";

export function getRepo(db: Db, repo: string): RepositoryRow | undefined {
  return db.select().from(repositories).where(eq(repositories.repo, repo)).get();
}

export function upsertRepo(db: Db, row: Partial<RepositoryRow> & { repo: string }): void {
  const existing = getRepo(db, row.repo);
  if (existing) {
    db.update(repositories)
      .set({ ...row, updatedAt: Date.now() })
      .where(eq(repositories.repo, row.repo))
      .run();
  } else {
    db.insert(repositories)
      .values({
        repo: row.repo,
        description: row.description ?? null,
        language: row.language ?? null,
        stars: row.stars ?? 0,
        sourceFiles: row.sourceFiles ?? null,
        defaultBranch: row.defaultBranch ?? "main",
        analyzedSha: row.analyzedSha ?? null,
        analyzedAt: row.analyzedAt ?? null,
        errorCount: row.errorCount ?? 0,
        status: row.status ?? "pending",
        lastError: row.lastError ?? null,
      })
      .run();
  }
}

/** Latest job_history status for (repo, sha, phase), or undefined if never run. */
export function phaseStatus(
  db: Db,
  repo: string,
  sha: string,
  phase: PhaseName
): "success" | "failed" | "running" | undefined {
  const row = db
    .select()
    .from(jobHistory)
    .where(and(eq(jobHistory.repo, repo), eq(jobHistory.analyzedSha, sha), eq(jobHistory.phase, phase)))
    .orderBy(desc(jobHistory.startedAt), desc(jobHistory.id))
    .get();
  return row?.status as "success" | "failed" | "running" | undefined;
}

export function recordPhase(
  db: Db,
  row: {
    repo: string;
    phase: PhaseName;
    status: "success" | "failed" | "running";
    startedAt: number;
    completedAt?: number;
    analyzedSha?: string;
    errorLog?: string;
    result?: string;
  }
): void {
  const durationMs = row.completedAt != null ? row.completedAt - row.startedAt : null;
  db.insert(jobHistory)
    .values({
      repo: row.repo,
      phase: row.phase,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt ?? null,
      durationMs,
      analyzedSha: row.analyzedSha ?? null,
      errorLog: row.errorLog ?? null,
      result: row.result ?? null,
    })
    .run();
}

/**
 * Latest job_history row (with result payload) for (repo, sha, phase).
 *
 * Ordered by insertion id as well as start time. Discovery records a `running`
 * row and its terminal row with the SAME startedAt, so ordering on startedAt
 * alone leaves the pair tied and lets SQLite pick either one. When the tie
 * resolved to `running`, phaseDone read the phase as unfinished and re-ran a
 * discovery that had already succeeded — hours of provider spend, decided by
 * row order.
 */
export function latestPhaseRun(
  db: Db,
  repo: string,
  sha: string,
  phase: PhaseName
): { status: string; result: string | null } | undefined {
  const row = db
    .select({
      status: jobHistory.status,
      result: jobHistory.result,
    })
    .from(jobHistory)
    .where(and(eq(jobHistory.repo, repo), eq(jobHistory.analyzedSha, sha), eq(jobHistory.phase, phase)))
    .orderBy(desc(jobHistory.startedAt), desc(jobHistory.id))
    .get();
  return row;
}

/**
 * Rows per INSERT statement. The errors table binds ~30 variables per row and
 * SQLite caps a statement at 32,766 — elasticsearch's 1,352 records blew that
 * as a single statement ("too many SQL variables") and threw away the whole
 * analysis. 500 rows ≈ 15k variables: half the ceiling, one statement for the
 * common repo.
 */
const INSERT_CHUNK_ROWS = 500;

function insertErrorRows(db: Db, rows: Omit<ErrorRow, "updatedAt">[]): void {
  for (const slice of chunk(rows as (typeof errors.$inferInsert)[], INSERT_CHUNK_ROWS)) {
    db.insert(errors).values(slice).run();
  }
}

/** Replace all errors for a repo inside a single transaction (§3.2). */
export function replaceErrors(db: Db, repo: string, rows: Omit<ErrorRow, "updatedAt">[]): void {
  tx(db, () => {
    db.delete(errors).where(eq(errors.repo, repo)).run();
    insertErrorRows(db, rows);
  });
}

export function errorsForRepo(db: Db, repo: string): ErrorRow[] {
  return db.select().from(errors).where(eq(errors.repo, repo)).all();
}

/** One error record by its page identity (repo + slug), for the review pass. */
export function errorBySlug(db: Db, repo: string, slug: string): ErrorRow | undefined {
  return db
    .select()
    .from(errors)
    .where(and(eq(errors.repo, repo), eq(errors.slug, slug)))
    .get();
}

/** Targeted field update for one error row (review patches). */
export function updateErrorFields(db: Db, id: string, fields: Partial<Omit<ErrorRow, "id">>): void {
  db.update(errors)
    .set({ ...fields, updatedAt: Date.now() })
    .where(eq(errors.id, id))
    .run();
}

/**
 * Integrate a COMPLETE analysis for `sha` as the repo's published version:
 * replace the records and advance the version pointer (status/analyzedSha/
 * errorCount) in one transaction. This is the only place a version becomes
 * visible to the exporter, so the errors table and the pointer can never
 * disagree — a re-analysis that dies partway leaves the prior version intact.
 */
export function integrateAnalyzedVersion(
  db: Db,
  repo: string,
  sha: string,
  rows: Omit<ErrorRow, "updatedAt">[]
): void {
  tx(db, () => {
    db.delete(errors).where(eq(errors.repo, repo)).run();
    insertErrorRows(db, rows);
    upsertRepo(db, {
      repo,
      status: "analyzed",
      analyzedSha: sha,
      analyzedAt: new Date().toISOString(),
      errorCount: rows.length,
      lastError: null,
    });
  });
}

/**
 * Record a failed (re-)analysis without disturbing the published version: a
 * repo that already has one keeps exporting it (lastError notes the failed
 * attempt); only a repo with nothing published is demoted to `failed`.
 */
export function recordAnalysisFailure(db: Db, repo: string, lastError: string): void {
  const existing = getRepo(db, repo);
  const hasPublishedVersion =
    (existing?.status === "analyzed" || existing?.status === "exported") &&
    existing.analyzedSha != null;
  if (hasPublishedVersion) {
    upsertRepo(db, { repo, lastError });
  } else {
    upsertRepo(db, { repo, status: "failed", lastError });
  }
}

export interface ResetSummary {
  repo: string;
  errorsDeleted: number;
  jobsDeleted: number;
}

/**
 * Return a repo to `pending`: drop its error records and phase history, clear
 * the analyzed SHA and the recorded failure.
 *
 * Resetting rather than deleting the row keeps `created_at` and any GitHub
 * metadata, so the repo stays part of the corpus and is simply re-analyzed.
 * The phase history has to go with it — `latestPhaseRun` is what makes resume
 * skip a phase, so leaving it behind would reset the status without actually
 * causing any work to be redone.
 */
export function resetRepo(db: Db, repo: string): ResetSummary {
  return tx(db, () => {
    const errorsDeleted = errorsForRepo(db, repo).length;
    const jobsDeleted = db.select().from(jobHistory).where(eq(jobHistory.repo, repo)).all().length;
    db.delete(errors).where(eq(errors.repo, repo)).run();
    db.delete(jobHistory).where(eq(jobHistory.repo, repo)).run();
    db.update(repositories)
      .set({
        status: "pending",
        lastError: null,
        analyzedSha: null,
        analyzedAt: null,
        errorCount: 0,
        updatedAt: Date.now(),
      })
      .where(eq(repositories.repo, repo))
      .run();
    return { repo, errorsDeleted, jobsDeleted };
  });
}

/** Repos in a given pipeline status. */
export function reposByStatus(db: Db, status: RepositoryRow["status"]): RepositoryRow[] {
  return db.select().from(repositories).where(eq(repositories.status, status)).all();
}

/**
 * Delete `running` phase rows for repos no run currently owns.
 *
 * Two kinds accumulate, and both are safe to drop once the repo is idle: rows
 * superseded by the terminal row of the same phase (recordPhase inserts rather
 * than updates, so every completed discovery leaves one), and rows from runs
 * that were killed mid-phase and will never write a terminal row. Keeping them
 * makes job_history useless for measuring throughput, since a phase appears
 * both started-and-unfinished and completed.
 */
export function purgeOrphanedJobs(db: Db, protectedRepos: Set<string>): number {
  const stale = db
    .select()
    .from(jobHistory)
    .where(eq(jobHistory.status, "running"))
    .all()
    .filter((j) => !protectedRepos.has(j.repo));
  for (const j of stale) db.delete(jobHistory).where(eq(jobHistory.id, j.id)).run();
  return stale.length;
}
