import type { Db } from "./db/client.js";
import type { ErrlookupConfig } from "./config/index.js";
import type { LlmProvider } from "./provider/types.js";
import type { PhaseName } from "@errlookup/schema";
import { cloneShallow, headSha, tempWorkDir } from "./vcs/git.js";
import { fetchRepoMeta } from "./vcs/github-meta.js";
import { upsertRepo } from "./db/store.js";
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
  try {
    log(`cloning ${repo} → ${work.path}`);
    await cloneShallow(repo, work.path, opts.cloneUrlOverride);
    const sha = await headSha(work.path);
    log(`HEAD sha ${sha}`);
    // GitHub-hosted repos get description/language/stars; local clones (tests)
    // and API failures leave nulls — honest gaps, never fabricated.
    if (!opts.cloneUrlOverride) {
      const meta = await fetchRepoMeta(repo);
      if (meta) {
        upsertRepo(opts.db, { repo, ...meta });
        log(`meta: ${meta.language ?? "?"} · ${meta.stars} stars`);
      } else {
        log("meta: GitHub API unavailable (kept null)");
      }
    }
    // NOTE: `return await` is required so the finally/cleanup waits for phases
    // to finish — a bare `return runPhases(...)` would run cleanup() immediately
    // and delete the clone dir while the LLM subprocess is still using it.
    return await runPhases({
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
  } finally {
    await work.cleanup();
  }
}
