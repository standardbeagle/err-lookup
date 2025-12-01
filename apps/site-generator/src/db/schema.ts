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
    description: text("description"),
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
    // Source code for SEO and debugging
    sourceCode: text("source_code"),           // The actual code that throws
    sourceCodeStart: integer("source_code_start"), // Start line of region
    sourceCodeEnd: integer("source_code_end"),     // End line of region
    githubUrl: text("github_url"),                 // Direct link to GitHub
    documentation: text("documentation"),
    solutions: text("solutions").array(),
    triggerScenarios: text("trigger_scenarios"),
    commonSituations: text("common_situations"),
    exampleFix: text("example_fix"),
    severity: varchar("severity", { length: 20 }),
    httpStatus: integer("http_status"),
    tags: text("tags").array(),
    // Defensive programming fields
    handlingStrategy: varchar("handling_strategy", { length: 50 }),
    validationCode: text("validation_code"),
    typeGuard: text("type_guard"),
    tryCatchPattern: text("try_catch_pattern"),
    preventionTips: text("prevention_tips").array(),
    // Article recommendations
    recommendedArticles: text("recommended_articles").array(),
    suggestedNewArticles: text("suggested_new_articles"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_errors_repo").on(table.repoId),
    index("idx_errors_code").on(table.errorCode),
  ]
);

export type Repository = typeof repositories.$inferSelect;
export type DbError = typeof errors.$inferSelect;
