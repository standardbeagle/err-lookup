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
  seeded: { added: number; requeued: number };
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
  const summary: ScanSummary = { ok: 0, failed: 0, unchanged: 0, leftQueued: 0, seeded };
  if (opts.seedOnly) return summary;

  // Under the drain lock any `running` row belongs to a dead scan.
  const reclaimed = reclaimRunningQueue(db);
  if (reclaimed > 0) log("*", `reclaimed ${reclaimed} orphaned running queue rows`);

  let consecutiveFailures = 0;
  let tripped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (tripped) return;
      const item = claimNextQueued(db);
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

      log(repo, "start");
      try {
        const r = await analyzeRepo(repo, {
          db,
          providers: opts.providers,
          cfg,
          phases: opts.phases,
          force: opts.force,
          cloneUrlOverride: cloneUrl,
          onLog: (m) => log(repo, m),
        });
        if (r.failed) {
          settleQueueItem(db, repo, "failed", r.failed);
          summary.failed++;
          consecutiveFailures++;
          log(repo, `FAILED: ${r.failed}`);
        } else {
          settleQueueItem(db, repo, "done");
          summary.ok++;
          consecutiveFailures = 0;
          log(repo, `→ ${r.errorCount} errors`);
        }
      } catch (e) {
        settleQueueItem(db, repo, "failed", (e as Error).message);
        summary.failed++;
        consecutiveFailures++;
        log(repo, `FAILED: ${(e as Error).message}`);
      }
      if (consecutiveFailures >= BREAKER && !tripped) {
        tripped = true;
        log("*", `breaker tripped: ${BREAKER} consecutive failures — leaving the rest queued`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, cfg.defaults.maxConcurrent) }, () => worker())
  );

  summary.leftQueued = queueByStatus(db, "queued").length;
  return summary;
}
