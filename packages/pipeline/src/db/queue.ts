import { eq, and, asc, desc } from "drizzle-orm";
import { tx, type Db } from "./client.js";
import { queue, type QueueRow } from "./schema.js";

/**
 * Re-entrant work queue over the corpus (§11.1). Every scan invocation seeds;
 * whichever process holds the drain lock claims repos one at a time. Seeding
 * is safe alongside an active drain — its workers keep claiming until the
 * queue is empty, so rows seeded mid-drain are picked up by the running scan
 * rather than waiting for the next one.
 */

/**
 * A failed repo re-enters the queue only after this cooloff. Failed discovery
 * burned 48h of provider time in one week (vs 23h of successful discovery)
 * by re-attempting the same failing repos every run; with 6h scan cadence a
 * chronic failer would otherwise re-bill 4x daily.
 */
export const FAILED_REQUEUE_COOLOFF_MS = Number.parseInt(
  process.env.ERRLOOKUP_FAILED_COOLOFF_MS ?? String(24 * 3600 * 1000),
  10
);

/**
 * Make every corpus repo eligible again: insert unknown repos as `queued`,
 * requeue terminal rows (done/skipped immediately, failed after the cooloff).
 * `queued` and `running` rows are left alone — seeding never steals in-flight
 * work.
 */
export function seedQueue(db: Db, repos: string[]): { added: number; requeued: number } {
  return tx(db, () => {
    let added = 0;
    let requeued = 0;
    for (const repo of repos) {
      const existing = db.select().from(queue).where(eq(queue.repo, repo)).get();
      if (!existing) {
        db.insert(queue).values({ repo, status: "queued" }).run();
        added++;
        continue;
      }
      if (existing.status === "queued" || existing.status === "running") continue;
      if (existing.status === "failed" && Date.now() - existing.updatedAt < FAILED_REQUEUE_COOLOFF_MS) {
        continue;
      }
      db.update(queue)
        .set({ status: "queued", lastError: null, updatedAt: Date.now() })
        .where(and(eq(queue.repo, repo), eq(queue.status, existing.status)))
        .run();
      requeued++;
    }
    return { added, requeued };
  });
}

/**
 * Return `running` rows to `queued`. Only call while holding the drain lock:
 * under it, any `running` row belongs to a dead scan.
 */
export function reclaimRunningQueue(db: Db): number {
  return db
    .update(queue)
    .set({ status: "queued", updatedAt: Date.now() })
    .where(eq(queue.status, "running"))
    .run().changes;
}

/**
 * Claim the next queued repo (optimistic update, looped on a lost race so
 * concurrent claimers stay correct without a lock).
 */
export function claimNextQueued(db: Db): QueueRow | null {
  for (;;) {
    const next = db
      .select()
      .from(queue)
      .where(eq(queue.status, "queued"))
      .orderBy(desc(queue.priority), asc(queue.updatedAt))
      .get();
    if (!next) return null;
    const claimed = db
      .update(queue)
      .set({ status: "running", attempts: next.attempts + 1, updatedAt: Date.now() })
      .where(and(eq(queue.repo, next.repo), eq(queue.status, "queued")))
      .run().changes;
    if (claimed === 1) return { ...next, status: "running", attempts: next.attempts + 1 };
  }
}

/** Terminal queue states. `skipped` = remote HEAD unchanged, nothing to do. */
export function settleQueueItem(
  db: Db,
  repo: string,
  status: "done" | "failed" | "skipped",
  lastError?: string
): void {
  db.update(queue)
    .set({ status, lastError: lastError ?? null, updatedAt: Date.now() })
    .where(eq(queue.repo, repo))
    .run();
}

/** Queue rows by status, for status displays and tests. */
export function queueByStatus(db: Db, status: string): QueueRow[] {
  return db.select().from(queue).where(eq(queue.status, status)).all();
}
