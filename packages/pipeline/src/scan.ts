import type { Db } from "./db/client.js";
import type { ErrlookupConfig } from "./config/index.js";
import type { LlmProvider } from "./provider/types.js";
import type { PhaseName } from "@errlookup/schema";
import { analyzeRepo } from "./pipeline.js";
import { getRepo } from "./db/store.js";
import {
  seedQueue,
  reclaimRunningQueue,
  claimNextQueued,
  settleQueueItem,
  requeueInfraFailure,
  queueByStatus,
} from "./db/queue.js";
import { remoteHeadSha } from "./vcs/git.js";
import { msUntilOffPeak } from "./util/peak.js";
import { sleep } from "./util/watchdog.js";

export interface ScanOptions {
  db: Db;
  providers: Record<string, LlmProvider>;
  cfg: ErrlookupConfig;
  /** Corpus to seed into the queue. */
  corpus: string[];
  phases?: Partial<Record<PhaseName, boolean>>;
  force?: boolean;
  /** Seed the queue and return without draining (used when another scan holds the drain lock). */
  seedOnly?: boolean;
  onLog?: (repo: string, msg: string) => void;
  /** Override clone/ls-remote URLs (tests: local fixture paths). */
  cloneUrlFor?: (repo: string) => string | undefined;
}

export interface ScanSummary {
  ok: number;
  failed: number;
  /** Remote HEAD unchanged since the published analysis — no clone spent. */
  unchanged: number;
  /** Left queued because the failure breaker tripped. */
  leftQueued: number;
  /** Requeued without a failed mark because the host, not the repo, was sick. */
  infraRequeued: number;
  seeded: { added: number; requeued: number };
}

/**
 * Failures caused by the host or the provider process, not the repo under
 * analysis: process/thread exhaustion, OOM, disk-full, DNS worker start, or a
 * provider agent that died before it could take the prompt. Blaming the repo
 * for these charged it a failed attempt plus the 24h cooloff — one fork storm
 * on 2026-08-10 benched ~50 healthy repos that way.
 */
export function isInfraFailure(msg: string): boolean {
  return /Resource temporarily unavailable|unable to create thread|cannot fork|getaddrinfo\(\) thread failed|\bEAGAIN\b|\bENOMEM\b|\bEMFILE\b|\bENFILE\b|\bENOSPC\b|no space left on device|\[spawn\]/i.test(
    msg
  );
}

/** Consecutive-failure breaker: provider quota exhaustion fails every repo the
 * same way; stop claiming and leave the rest queued for the next scan (§11.2). */
const BREAKER = 5;

/**
 * Re-entrant corpus scan (§11.1): seed the queue, then drain it with
 * maxConcurrent workers that each loop claim → check remote HEAD → analyze →
 * settle. Because workers claim until the queue is empty, rows seeded by a
 * later invocation land in THIS drain. Every repo integrates independently
 * (version-aware), so the publisher ships each project as it completes — a
 * killed drain loses nothing but the repos it never claimed.
 */
export async function runScan(opts: ScanOptions): Promise<ScanSummary> {
  const { db, cfg } = opts;
  const log = opts.onLog ?? (() => {});

  const seeded = seedQueue(db, opts.corpus);
  const summary: ScanSummary = { ok: 0, failed: 0, unchanged: 0, leftQueued: 0, infraRequeued: 0, seeded };
  if (opts.seedOnly) return summary;

  // Under the drain lock any `running` row belongs to a dead scan.
  const reclaimed = reclaimRunningQueue(db);
  if (reclaimed > 0) log("*", `reclaimed ${reclaimed} orphaned running queue rows`);

  let consecutiveFailures = 0;
  let tripped = false;

  // Both failure paths (phase-level and thrown) settle through here so infra
  // classification cannot drift between them. Infra failures escalate instead
  // of failing: the limits exist for system stability, so a repo that hit them
  // retries with more of the machine to itself — first holding the large-repo
  // slot (level 1), then with no other repos running at all (level 2). Only a
  // level-2 infra failure settles as failed. Every failure still counts toward
  // the breaker — a sick host should stop the drain quickly.
  const settleFailure = (repo: string, msg: string, ranAt: number, heldLargeSlot: boolean): void => {
    if (isInfraFailure(msg) && ranAt < 2) {
      // A run that already held the large slot skips straight to exclusive.
      const next = ranAt >= 1 || heldLargeSlot ? 2 : 1;
      requeueInfraFailure(db, repo, msg, next);
      summary.infraRequeued++;
      log(repo, `INFRA FAILURE — requeued at escalation level ${next} (no cooloff): ${msg}`);
    } else {
      settleQueueItem(db, repo, "failed", msg);
      summary.failed++;
      log(repo, ranAt >= 2 && isInfraFailure(msg) ? `FAILED even running alone: ${msg}` : `FAILED: ${msg}`);
    }
    consecutiveFailures++;
  };

  const worker = async (which: "concurrent" | "exclusive"): Promise<void> => {
    for (;;) {
      if (tripped) return;
      const item = claimNextQueued(db, which);
      if (!item) return;
      const repo = item.repo;

      // Peak-price gate: checked between repos, never mid-repo (§ batch note).
      if (cfg.defaults.skipPeak) {
        const waitMs = msUntilOffPeak(new Date());
        if (waitMs > 0) {
          log(repo, `peak pricing until ${new Date(Date.now() + waitMs).toISOString()} — holding`);
          await sleep(waitMs);
        }
      }

      // Unchanged fast path: one ls-remote instead of a shallow clone. Only
      // repos with a published version qualify; a lookup failure is not fatal —
      // the full analysis path does its own clone and reports properly.
      const cloneUrl = opts.cloneUrlFor?.(repo);
      if (!opts.force) {
        const row = getRepo(db, repo);
        if (row?.analyzedSha && (row.status === "analyzed" || row.status === "exported")) {
          try {
            const remote = await remoteHeadSha(repo, cloneUrl);
            if (remote === row.analyzedSha) {
              settleQueueItem(db, repo, "skipped");
              summary.unchanged++;
              log(repo, `unchanged at ${remote.slice(0, 8)} — skipped without clone`);
              continue;
            }
          } catch (e) {
            log(repo, `ls-remote failed (${(e as Error).message}) — falling through to clone`);
          }
        }
      }

      log(repo, item.solo > 0 ? `start (escalation level ${item.solo})` : "start");
      try {
        const r = await analyzeRepo(repo, {
          db,
          providers: opts.providers,
          cfg,
          phases: opts.phases,
          force: opts.force,
          cloneUrlOverride: cloneUrl,
          solo: item.solo >= 1,
          onLog: (m) => log(repo, m),
        });
        if (r.failed) {
          settleFailure(repo, r.failed, item.solo, r.heldLargeSlot ?? false);
        } else {
          settleQueueItem(db, repo, "done");
          summary.ok++;
          consecutiveFailures = 0;
          log(repo, `→ ${r.errorCount} errors`);
        }
      } catch (e) {
        settleFailure(repo, (e as Error).message, item.solo, (e as { heldLargeSlot?: boolean }).heldLargeSlot ?? false);
      }
      if (consecutiveFailures >= BREAKER && !tripped) {
        tripped = true;
        log("*", `breaker tripped: ${BREAKER} consecutive failures — leaving the rest queued`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, cfg.defaults.maxConcurrent) }, () => worker("concurrent"))
  );

  // Exclusive pass: level-2 repos run only after every concurrent worker has
  // drained out, one at a time, with the whole machine to themselves. Rows
  // escalated to level 2 during the pass above are picked up here in the same
  // run.
  if (!tripped && queueByStatus(db, "queued").some((r) => r.solo >= 2)) {
    log("*", "exclusive pass: retrying resource-failed repos with no other repos running");
    await worker("exclusive");
  }

  summary.leftQueued = queueByStatus(db, "queued").length;
  return summary;
}
