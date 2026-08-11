import type { Db } from "./db/client.js";
import type { ErrlookupConfig } from "./config/index.js";
import type { LlmProvider } from "./provider/types.js";
import type { PhaseName } from "@errlookup/schema";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloneShallow, headSha, tempWorkDir } from "./vcs/git.js";

const execFileAsync = promisify(execFile);

/** Size of a directory in MB via `du -sm` (fast, no JS tree walk). */
async function dirSizeMb(path: string): Promise<number> {
  const { stdout } = await execFileAsync("du", ["-sm", path]);
  return Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Machine-wide mutex for large-repo analysis: mkdir is atomic, so the first
 * process to create the lock dir owns it; others wait. A recorded PID lets a
 * waiting process reap locks left by crashed runs. This serializes big clones
 * across overlapping runs (cron + manual + comparisons) without slowing the
 * common small-repo path.
 */
export async function acquireLargeRepoLock(
  lockDir: string,
  onWait?: (holder: number | null) => void,
  pollMs = 10_000
): Promise<() => void> {
  const pidFile = join(lockDir, "pid");
  let waited = false;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      let holder: number | null = null;
      try {
        holder = Number.parseInt(readFileSync(pidFile, "utf8"), 10) || null;
      } catch {
        /* holder mid-write or gone */
      }
      if (holder) {
        try {
          process.kill(holder, 0); // alive?
        } catch {
          rmSync(lockDir, { recursive: true, force: true }); // stale — reap and retry
          continue;
        }
      }
      if (!waited) {
        waited = true;
        onWait?.(holder);
      }
      await sleep(pollMs);
    }
  }
}
import { fetchRepoMeta } from "./vcs/github-meta.js";
import { countSourceFiles } from "./phase/candidates.js";
import { upsertRepo, recordAnalysisFailure } from "./db/store.js";
import { runPhases, type RunPhasesResult } from "./phase/runner.js";

export interface AnalyzeOptions {
  db: Db;
  providers: Record<string, LlmProvider>;
  cfg: ErrlookupConfig;
  phases?: Partial<Record<PhaseName, boolean>>;
  force?: boolean;
  onLog?: (msg: string) => void;
  /** Override the git clone URL (tests: a local path). */
  cloneUrlOverride?: string;
  /** Skip cloning and analyze this dir directly (tests / resume). */
  repoPath?: string;
  /** Pinned SHA when repoPath is provided. */
  sha?: string;
  /** Second try after a resource failure: hold the machine-wide slot for the
   *  whole run, clone included — the previous attempt may have died there. */
  solo?: boolean;
}

/**
 * End-to-end single-repo analysis (§4): clone shallow → record HEAD SHA → run
 * phases → write DB → cleanup clone dir. Idempotent + resumable per phase.
 */
export async function analyzeRepo(repo: string, opts: AnalyzeOptions): Promise<RunPhasesResult> {
  const log = opts.onLog ?? (() => {});
  log(`analyzing ${repo}`);

  if (opts.repoPath && opts.sha) {
    return runPhases({
      db: opts.db,
      repo,
      sha: opts.sha,
      repoPath: opts.repoPath,
      providers: opts.providers,
      cfg: opts.cfg,
      phases: opts.phases,
      force: opts.force,
      onLog: opts.onLog,
    });
  }

  const work = await tempWorkDir();
  let releaseLargeLock: (() => void) | null = null;
  const lockDir = process.env.ERRLOOKUP_LARGE_LOCK_DIR ?? join(tmpdir(), "errlookup-large-repo.lock");
  try {
    if (opts.solo) {
      log("solo retry after a resource failure: acquiring the machine-wide slot before cloning");
      releaseLargeLock = await acquireLargeRepoLock(lockDir, (holder) =>
        log(`solo slot held by pid ${holder ?? "?"} — waiting`)
      );
      log("solo slot acquired");
    }
    log(`cloning ${repo} → ${work.path}`);
    await cloneShallow(repo, work.path, opts.cloneUrlOverride);

    // Disk budget (§11.1/§11.3). Two tiers:
    //  - hard cap (default 20GB): recorded skipped_too_large, never analyzed;
    //  - large threshold (default 2GB): analyzed, but serialized machine-wide
    //    so at most one large clone is in flight across overlapping runs.
    const hardCapMb = Number.parseInt(process.env.ERRLOOKUP_MAX_CLONE_MB ?? "20480", 10);
    const largeMb = Number.parseInt(process.env.ERRLOOKUP_LARGE_CLONE_MB ?? "2048", 10);
    const sizeMb = await dirSizeMb(work.path);
    if (sizeMb > hardCapMb) {
      const msg = `skipped_too_large: clone ${sizeMb}MB > cap ${hardCapMb}MB`;
      recordAnalysisFailure(opts.db, repo, msg);
      log(msg);
      return { errorCount: 0, rejects: [], skipped: [], failed: msg };
    }
    if (sizeMb > largeMb && !releaseLargeLock) {
      log(`large repo (${sizeMb}MB > ${largeMb}MB): acquiring large-repo slot`);
      releaseLargeLock = await acquireLargeRepoLock(lockDir, (holder) =>
        log(`large-repo slot held by pid ${holder ?? "?"} — waiting`)
      );
      log("large-repo slot acquired");
    }

    const sha = await headSha(work.path);
    log(`HEAD sha ${sha}`);
    const sourceFiles = countSourceFiles(work.path);
    upsertRepo(opts.db, { repo, sourceFiles });
    // GitHub-hosted repos get description/language/stars; local clones (tests)
    // and API failures leave nulls — honest gaps, never fabricated.
    if (!opts.cloneUrlOverride) {
      const meta = await fetchRepoMeta(repo);
      if (meta) {
        upsertRepo(opts.db, { repo, ...meta });
        log(`meta: ${meta.language ?? "?"} · ${sourceFiles} source files · ${meta.stars} stars`);
      } else {
        log("meta: GitHub API unavailable (kept null)");
      }
    }
    // NOTE: `return await` is required so the finally/cleanup waits for phases
    // to finish — a bare `return runPhases(...)` would run cleanup() immediately
    // and delete the clone dir while the LLM subprocess is still using it.
    const result = await runPhases({
      db: opts.db,
      repo,
      sha,
      repoPath: work.path,
      providers: opts.providers,
      cfg: opts.cfg,
      phases: opts.phases,
      force: opts.force,
      onLog: opts.onLog,
    });
    return { ...result, heldLargeSlot: releaseLargeLock !== null };
  } catch (e) {
    // Thrown failures (clone, du, phase faults) carry whether this run had the
    // slot, so the scan's escalation can read it off the error.
    (e as { heldLargeSlot?: boolean }).heldLargeSlot = releaseLargeLock !== null;
    throw e;
  } finally {
    releaseLargeLock?.();
    await work.cleanup();
  }
}
