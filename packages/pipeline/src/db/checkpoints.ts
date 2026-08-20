import { eq, and, ne } from "drizzle-orm";
import type { Db } from "./client.js";
import { phaseBatches } from "./schema.js";

/**
 * Durable intra-phase batch results (see schema.phaseBatches). Phases receive
 * this narrow interface instead of the Db so their tests stay provider-only.
 */
export interface BatchCheckpoint {
  /** Persisted result for this batch key at the checkpoint's repo+sha, or null. */
  get(key: string): string | null;
  /** Persist a completed batch's result before the pool claims the next one. */
  put(key: string, result: string): void;
}

/**
 * Checkpoint handle for one repo+sha+phase. Opening it drops rows the repo
 * left behind at other SHAs — HEAD moved, so those batches can never be
 * reused and would otherwise accumulate until the next phase success.
 */
export function phaseBatchCheckpoint(db: Db, repo: string, sha: string, phase: string): BatchCheckpoint {
  db.delete(phaseBatches)
    .where(and(eq(phaseBatches.repo, repo), eq(phaseBatches.phase, phase), ne(phaseBatches.sha, sha)))
    .run();
  return {
    get(key) {
      return (
        db
          .select({ result: phaseBatches.result })
          .from(phaseBatches)
          .where(
            and(
              eq(phaseBatches.repo, repo),
              eq(phaseBatches.sha, sha),
              eq(phaseBatches.phase, phase),
              eq(phaseBatches.batchKey, key)
            )
          )
          .get()?.result ?? null
      );
    },
    put(key, result) {
      db.insert(phaseBatches)
        .values({ repo, sha, phase, batchKey: key, result, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: [phaseBatches.repo, phaseBatches.sha, phaseBatches.phase, phaseBatches.batchKey],
          set: { result, updatedAt: Date.now() },
        })
        .run();
    },
  };
}

/** Drop a repo's checkpoints for one phase — its payload now lives in job_history. */
export function clearPhaseBatches(db: Db, repo: string, phase: string): void {
  db.delete(phaseBatches).where(and(eq(phaseBatches.repo, repo), eq(phaseBatches.phase, phase))).run();
}
