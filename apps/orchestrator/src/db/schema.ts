import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    githubId: bigint("github_id", { mode: "number" }).unique().notNull(),
    fullName: varchar("full_name", { length: 255 }).notNull(),
    language: varchar("language", { length: 50 }),
    stars: integer("stars").default(0),
    lastReleaseAt: timestamp("last_release_at", { withTimezone: true }),
    lastAnalyzedAt: timestamp("last_analyzed_at", { withTimezone: true }),
    lastAnalyzedSha: varchar("last_analyzed_sha", { length: 40 }),
    cloudflareProjectId: varchar("cloudflare_project_id", { length: 100 }),
    subdomain: varchar("subdomain", { length: 100 }),
    status: varchar("status", { length: 20 }).default("pending"),
    errorCount: integer("error_count").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_repos_status").on(table.status, table.lastAnalyzedAt),
    uniqueIndex("idx_repos_github_id").on(table.githubId),
  ]
);

export const errors = pgTable(
  "errors",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id").references(() => repositories.id),
    errorCode: varchar("error_code", { length: 255 }),
    errorMessage: text("error_message").notNull(),
    errorType: varchar("error_type", { length: 50 }),
    filePath: varchar("file_path", { length: 500 }),
    lineNumber: integer("line_number"),
    context: text("context"),
    documentation: text("documentation"),
    solutions: text("solutions").array(),
    severity: varchar("severity", { length: 20 }),
    httpStatus: integer("http_status"),
    tags: text("tags").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_errors_repo").on(table.repoId),
    index("idx_errors_code").on(table.errorCode),
  ]
);

export const jobHistory = pgTable(
  "job_history",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id").references(() => repositories.id),
    jobType: varchar("job_type", { length: 50 }),
    status: varchar("status", { length: 20 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorLog: text("error_log"),
    metadata: text("metadata"),
  },
  (table) => [index("idx_jobs_repo").on(table.repoId, table.startedAt)]
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type DbError = typeof errors.$inferSelect;
export type NewDbError = typeof errors.$inferInsert;
export type JobHistory = typeof jobHistory.$inferSelect;
export type NewJobHistory = typeof jobHistory.$inferInsert;
