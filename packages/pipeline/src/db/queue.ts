import { eq, and, asc, desc, lt, sql } from "drizzle-orm";
import { tx, type Db } from "./client.js";
import { queue, repositories, type QueueRow } from "./schema.js";

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
      // A fresh seed is a fresh start: terminal rows come back best-effort,
      // dropping any solo mark from a previous incident.
      db.update(queue)
        .set({ status: "queued", solo: 0, lastError: null, updatedAt: Date.now() })
        .where(and(eq(queue.repo, repo), eq(queue.status, existing.status)))
        .run();
      requeued++;
    }
    return { added, requeued };
  });
}

/**
 * Return a claimed repo to `queued` after a host-infrastructure failure
 * (fork/thread exhaustion, OOM, provider process that never started). The repo
 * did nothing wrong, so it must not eat the failed-status cooloff — but the
 * fresh `updatedAt` sends it to the back of the claim order, so the current
 * drain finishes the healthy queue before retrying it. `solo` records the
 * escalation the retry runs at: the limits exist for system stability, so a
 * repo that hit them gets its next try with more of the machine to itself —
 * level 1 holds the large-repo slot, level 2 runs with no other repos at all.
 */
export function requeueInfraFailure(db: Db, repo: string, lastError: string, solo: 1 | 2): void {
  db.update(queue)
    .set({ status: "queued", solo, lastError, updatedAt: Date.now() })
    .where(eq(queue.repo, repo))
    .run();
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

/** Which kind of work a claim should reach for first. */
export type ClaimPreference = "fresh" | "rescan";

/**
 * Claim the next queued repo (optimistic update, looped on a lost race so
 * concurrent claimers stay correct without a lock). The concurrent drain
 * claims levels 0-1 only; level-2 (exclusive) rows are claimed by the
 * exclusive pass after every worker has drained out, so they truly run alone.
 *
 * `prefer` picks which kind of row sorts first — `fresh` (no published
 * analysis yet) or `rescan` (published, HEAD may have moved) — then priority,
 * then age. It is an ordering, not a filter: when the preferred kind is
 * exhausted the other kind is claimed. The scan alternates the preference to
 * balance importing new repos against refreshing published ones; left to
 * priority/age alone the drain re-spent every relaunch on the same
 * already-published top rows and the 2026-08 batch-2 import sat at 808
 * analyzed for days.
 */
export function claimNextQueued(
  db: Db,
  which: "concurrent" | "exclusive" = "concurrent",
  prefer: ClaimPreference = "fresh"
): QueueRow | null {
  const rescanFirst = prefer === "rescan";
  for (;;) {
    const next = db
      .select({ queue })
      .from(queue)
      .leftJoin(repositories, eq(repositories.repo, queue.repo))
      .where(
        and(eq(queue.status, "queued"), which === "exclusive" ? eq(queue.solo, 2) : lt(queue.solo, 2))
      )
      .orderBy(
        rescanFirst ? sql`${repositories.analyzedSha} IS NULL` : sql`${repositories.analyzedSha} IS NOT NULL`,
        desc(queue.priority),
        asc(queue.updatedAt)
      )
      .get()?.queue;
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
