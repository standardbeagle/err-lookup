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

// Educational resources for linking from error pages
export const resources = pgTable(
  "resources",
  {
    id: serial("id").primaryKey(),
    slug: varchar("slug", { length: 100 }).unique().notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    category: varchar("category", { length: 50 }).notNull(),
    subcategory: varchar("subcategory", { length: 50 }),
    summary: text("summary").notNull(),
    content: text("content").notNull(),
    tags: text("tags").array(),
    relatedSlugs: text("related_slugs").array(),
    externalLinks: text("external_links").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_resources_category").on(table.category),
    index("idx_resources_slug").on(table.slug),
  ]
);

// Link errors to relevant resources
export const errorResources = pgTable(
  "error_resources",
  {
    id: serial("id").primaryKey(),
    errorId: integer("error_id").references(() => errors.id),
    resourceId: integer("resource_id").references(() => resources.id),
    relevance: varchar("relevance", { length: 20 }).default("related"),
  },
  (table) => [
    index("idx_error_resources_error").on(table.errorId),
    index("idx_error_resources_resource").on(table.resourceId),
  ]
);

export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type DbError = typeof errors.$inferSelect;
export type NewDbError = typeof errors.$inferInsert;
export type JobHistory = typeof jobHistory.$inferSelect;
export type NewJobHistory = typeof jobHistory.$inferInsert;
export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;
export type ErrorResource = typeof errorResources.$inferSelect;
export type NewErrorResource = typeof errorResources.$inferInsert;
