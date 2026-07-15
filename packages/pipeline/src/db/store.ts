import { eq, desc, and } from "drizzle-orm";
import type { Db } from "./client.js";
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
    .orderBy(desc(jobHistory.startedAt))
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

/** Latest job_history row (with result payload) for (repo, sha, phase). */
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
    .orderBy(desc(jobHistory.startedAt))
    .get();
  return row;
}

/** Replace all errors for a repo inside a single transaction (§3.2). */
export function replaceErrors(db: Db, repo: string, rows: Omit<ErrorRow, "updatedAt">[]): void {
  db.transaction((tx) => {
    tx.delete(errors).where(eq(errors.repo, repo)).run();
    if (rows.length > 0) {
      tx.insert(errors)
        .values(rows as (typeof errors.$inferInsert)[])
        .run();
    }
  });
}

export function errorsForRepo(db: Db, repo: string): ErrorRow[] {
  return db.select().from(errors).where(eq(errors.repo, repo)).all();
}
