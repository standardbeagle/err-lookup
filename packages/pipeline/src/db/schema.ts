import { sqliteTable, text, integer, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema — pipeline working state only (§3.2). Never shipped.
 * The static JSON export (§5) is the publication format.
 *
 * Arrays / structured fields are stored as JSON text columns. All multi-row
 * writes happen in transactions (see db/client.ts). WAL mode on.
 */

export const repositories = sqliteTable(
  "repositories",
  {
    repo: text("repo").primaryKey(),
    description: text("description"),
    language: text("language"),
    stars: integer("stars").notNull().default(0),
    /** Analyzable source files in the clone (null until a scan/backfill counts them). */
    sourceFiles: integer("source_files"),
    defaultBranch: text("default_branch").notNull(),
    analyzedSha: text("analyzed_sha"),
    analyzedAt: text("analyzed_at"),
    errorCount: integer("error_count").notNull().default(0),
    // Pipeline working state
    status: text("status", { enum: ["pending", "analyzing", "analyzed", "failed", "exported"] })
      .notNull()
      .default("pending"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [index("idx_repos_status").on(table.status, table.updatedAt)]
);

export const errors = sqliteTable(
  "errors",
  {
    id: text("id").primaryKey(),
    repo: text("repo").notNull(),
    slug: text("slug").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message").notNull(),
    messagePattern: text("message_pattern").notNull(),
    errorType: text("error_type").notNull(),
    errorClass: text("error_class"),
    httpStatus: integer("http_status"),
    severity: text("severity").notNull(),

    filePath: text("file_path").notNull(),
    lineNumber: integer("line_number"),
    sourceCode: text("source_code"),
    sourceCodeStart: integer("source_code_start"),
    sourceCodeEnd: integer("source_code_end"),
    githubUrl: text("github_url").notNull(),

    documentation: text("documentation"),
    triggerScenarios: text("trigger_scenarios"),
    commonSituations: text("common_situations"),
    solutions: text("solutions", { mode: "json" }).$type<string[]>(),
    exampleFix: text("example_fix"),

    handlingStrategy: text("handling_strategy"),
    validationCode: text("validation_code"),
    typeGuard: text("type_guard"),
    tryCatchPattern: text("try_catch_pattern"),
    preventionTips: text("prevention_tips", { mode: "json" }).$type<string[]>(),

    tags: text("tags", { mode: "json" }).$type<string[]>(),
    /** Kebab-case cross-library family tag — the collector's third cluster key. */
    backgroundTag: text("background_tag"),
    analyzedSha: text("analyzed_sha").notNull(),
    analyzedAt: text("analyzed_at").notNull(),
    /**
     * Honest lastmod: sha256 of the user-facing fields, and when they last
     * actually changed. analyzedAt bumps on every re-analysis; sitemap lastmod
     * must not (the Aug-17-20 requeue stall re-analyzed the same repos daily
     * and churned lastmod on unchanged pages). Set by integrateAnalyzedVersion;
     * null on rows from before the columns existed (readers fall back to
     * analyzedAt).
     */
    contentHash: text("content_hash"),
    contentChangedAt: text("content_changed_at"),
    schemaVersion: integer("schema_version").notNull().default(2),
    /**
     * Consecutive re-analyses that did not rediscover this record; reset to 0
     * whenever one does. It never causes a deletion — a published page is not
     * withdrawn because an LLM pass stopped seeing it — it marks records
     * stranded on an older version of their repo, which is what a fill-in pass
     * needs to find them.
     */
    missedRuns: integer("missed_runs").notNull().default(0),

    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [
    uniqueIndex("idx_errors_repo_slug").on(table.repo, table.slug),
    index("idx_errors_repo").on(table.repo),
    index("idx_errors_code").on(table.errorCode),
    index("idx_errors_background_tag").on(table.backgroundTag),
  ]
);

export const jobHistory = sqliteTable(
  "job_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    repo: text("repo").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(), // running | success | failed | skipped
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    durationMs: integer("duration_ms"),
    analyzedSha: text("analyzed_sha"),
    errorLog: text("error_log"),
    /** Optional phase output (e.g. discovery's discovered[] JSON) for resuming. */
    result: text("result"),
  },
  (table) => [index("idx_jobs_repo").on(table.repo, table.startedAt)]
);

// Queue table for corpus blitz (§11.1). Used by `corpus build` / `batch --from-queue`.
export const queue = sqliteTable(
  "queue",
  {
    repo: text("repo").primaryKey(),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("queued"), // queued | running | done | failed | skipped
    attempts: integer("attempts").notNull().default(0),
    // Resource-failure escalation level. 0 = best effort at full concurrency;
    // 1 = previous attempt died on host resources → retry holding the
    // machine-wide large-repo slot; 2 = died even in the large slot → retry
    // with no other repos running at all. An infra failure at level 2 settles
    // as failed.
    solo: integer("solo").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [index("idx_queue_status_priority").on(table.status, table.priority)]
);

/**
 * Info pages — collector output (cross-repo background articles). One row per
 * error-family cluster; `clusterKey` is the collector's idempotency key, so a
 * twice-daily run only writes pages for clusters that gained one since.
 * Exported with the dataset and rendered at /info/<slug>/.
 */
export const infoPages = sqliteTable(
  "info_pages",
  {
    slug: text("slug").primaryKey(),
    clusterKey: text("cluster_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    background: text("background").notNull(),
    commonCauses: text("common_causes", { mode: "json" })
      .$type<{ cause: string; detail: string }[]>()
      .notNull(),
    fixes: text("fixes", { mode: "json" }).$type<string[]>().notNull(),
    guideSlugs: text("guide_slugs", { mode: "json" }).$type<string[]>().notNull(),
    errorIds: text("error_ids", { mode: "json" }).$type<string[]>().notNull(),
    errorCount: integer("error_count").notNull(),
    repoCount: integer("repo_count").notNull(),
    generatedAt: text("generated_at").notNull(),
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [uniqueIndex("idx_info_pages_cluster").on(table.clusterKey)]
);

/**
 * Intra-phase batch checkpoints. job_history resumes a repo per PHASE, but a
 * killed drain still lost every completed batch inside the running phase — a
 * 94-batch discovery dying at batch 83 restarted from batch 1, and on this
 * host (a WSL2 VM the Windows side restarts at will) that happened often
 * enough to reduce net throughput to ~zero. Each completed batch persists
 * here as it finishes, keyed by content so a resume only re-runs batches
 * whose exact input was never answered. Rows are deleted when their phase
 * records success (the payload then lives in job_history.result).
 */
export const phaseBatches = sqliteTable(
  "phase_batches",
  {
    repo: text("repo").notNull(),
    sha: text("sha").notNull(),
    phase: text("phase").notNull(), // discovery | analysis
    batchKey: text("batch_key").notNull(),
    result: text("result").notNull(),
    updatedAt: integer("updated_at").notNull().$defaultFn(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.repo, table.sha, table.phase, table.batchKey] })]
);

/**
 * Crawl-surface admission ledger (scheduled publishing). The dataset always
 * ships whole — search shards, /api, and the MCP see every analyzed repo the
 * moment it lands — but the crawlable site (sitemaps, indexable pages, repo
 * listings) admits new repos on a daily budget. Bulk-publishing ~100k pages in
 * one August week is what made Google refuse admission of whole repo blocks
 * (GSC "Crawled - currently not indexed" 3.5k→11.3k on 2026-08-17) and then
 * withdraw its crawl. A row here means the repo is advertised to crawlers;
 * absence means its pages render noindex and stay out of the sitemaps.
 */
export const publishedRepos = sqliteTable("published_repos", {
  repo: text("repo").primaryKey(),
  firstPublishedAt: text("first_published_at").notNull(),
});

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;
export type ErrorRow = typeof errors.$inferSelect;
export type NewErrorRow = typeof errors.$inferInsert;
export type JobHistoryRow = typeof jobHistory.$inferSelect;
export type NewJobHistoryRow = typeof jobHistory.$inferInsert;
export type QueueRow = typeof queue.$inferSelect;
export type NewQueueRow = typeof queue.$inferInsert;
export type InfoPageRow = typeof infoPages.$inferSelect;
export type NewInfoPageRow = typeof infoPages.$inferInsert;
