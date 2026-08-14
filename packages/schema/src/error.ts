/**
 * @errlookup/schema — canonical error knowledge base schema.
 *
 * Single source of truth for the err-lookup v2 pipeline, static site, and MCP
 * server. All three components validate against these zod schemas:
 *   - pipeline validates on write (SQLite + export)
 *   - site build validates on read (exported JSON)
 *   - MCP server validates on download (cached dataset)
 *
 * Fail fast on validation errors. Never silently drop or coerce.
 *
 * See docs/rebuild-spec.md §3.1.
 */
import { z } from "zod";

/** Current schema version. Bump on incompatible changes to ErrorEntry/RepoEntry. */
export const CURRENT_SCHEMA_VERSION = 2 as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Stable id: sha256(repo + errorCode|normalizedMessage + filePath).slice(0,16) — 16 hex chars. */
export const ErrorId = z.string().regex(/^[0-9a-f]{16}$/, "id must be 16 lowercase hex chars");

/** "owner/name" GitHub repo coordinate. */
export const RepoCoord = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be 'owner/name'");

/** URL-safe slug, unique within a repo. */
export const Slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "slug must be lowercase URL-safe kebab");

/** Lowercase kebab-case tag: "network", "typescript", "config". */
export const Tag = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "tag must be lowercase kebab-case");

/** Full 40-char git SHA. Used for permalink pinning (never branch-relative). */
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, "analyzedSha must be 40 hex chars");

/** ISO 8601 UTC timestamp, e.g. "2026-07-14T00:00:00Z". */
export const IsoUtc = z.string().datetime({ message: "analyzedAt must be ISO 8601 UTC" });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ErrorType = z.enum([
  "exception",
  "error_code",
  "console",
  "http",
  "validation",
  "panic",
]);
export type ErrorType = z.infer<typeof ErrorType>;

export const Severity = z.enum(["critical", "error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

export const HandlingStrategy = z.enum([
  "try-catch",
  "type-guard",
  "validation",
  "retry",
  "fallback",
]);
export type HandlingStrategy = z.infer<typeof HandlingStrategy>;

// ---------------------------------------------------------------------------
// RepoEntry
// ---------------------------------------------------------------------------

export const RepoEntry = z
  .object({
    repo: RepoCoord,
    description: z.string().nullable(),
    language: z.string().nullable(),
    stars: z.number().int().min(0),
    /** Analyzable source files in the repo; null for repos scanned before counting existed. */
    sourceFiles: z.number().int().min(0).nullable(),
    defaultBranch: z.string().min(1),
    analyzedSha: GitSha,
    analyzedAt: IsoUtc,
    errorCount: z.number().int().min(0),
  })
  .strict();
export type RepoEntry = z.infer<typeof RepoEntry>;

// ---------------------------------------------------------------------------
// ErrorEntry
// ---------------------------------------------------------------------------

export const ErrorEntry = z
  .object({
    id: ErrorId,
    repo: RepoCoord,
    slug: Slug,
    errorCode: z.string().min(1).nullable(),
    errorMessage: z.string().min(1),
    messagePattern: z.string().min(1),
    errorType: ErrorType,
    errorClass: z.string().min(1).nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    severity: Severity,

    filePath: z.string().min(1),
    lineNumber: z.number().int().min(1).nullable(),
    sourceCode: z.string().nullable(),
    sourceCodeStart: z.number().int().min(1).nullable(),
    sourceCodeEnd: z.number().int().min(1).nullable(),
    githubUrl: z.string().url(),

    documentation: z.string().min(1),
    triggerScenarios: z.string().min(1),
    commonSituations: z.string().min(1),
    solutions: z.array(z.string().min(1)),
    exampleFix: z.string().nullable(),

    handlingStrategy: HandlingStrategy.nullable(),
    validationCode: z.string().nullable(),
    typeGuard: z.string().nullable(),
    tryCatchPattern: z.string().nullable(),
    preventionTips: z.array(z.string().min(1)),

    tags: z.array(Tag),
    /** One kebab-case tag naming the cross-library error family — the key the
     *  info-page collector clusters on and error pages link through. Defaulted
     *  so records analyzed before the field existed keep validating. */
    backgroundTag: Tag.nullable().default(null),
    analyzedSha: GitSha,
    analyzedAt: IsoUtc,
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // sourceCode region must be ≤ 40 lines (spec §3.1, §4.2 phase 2).
    if (entry.sourceCode !== null) {
      const lines = entry.sourceCode.split("\n").length;
      if (lines > 40) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `sourceCode must be ≤40 lines, got ${lines}`,
          path: ["sourceCode"],
        });
      }
    }
    // Line span must be coherent when present.
    if (
      entry.sourceCodeStart !== null &&
      entry.sourceCodeEnd !== null &&
      entry.sourceCodeEnd < entry.sourceCodeStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceCodeEnd must be ≥ sourceCodeStart",
        path: ["sourceCodeEnd"],
      });
    }
    // lineNumber and sourceCode span should live within a sane range.
    if (
      entry.lineNumber !== null &&
      entry.sourceCodeStart !== null &&
      entry.lineNumber < entry.sourceCodeStart
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lineNumber should be ≥ sourceCodeStart",
        path: ["lineNumber"],
      });
    }
  });
export type ErrorEntry = z.infer<typeof ErrorEntry>;

// ---------------------------------------------------------------------------
// Pipeline working-state enums (not part of the published dataset)
// ---------------------------------------------------------------------------

export const RepoStatus = z.enum([
  "pending",
  "analyzing",
  "analyzed",
  "failed",
  "exported",
]);
export type RepoStatus = z.infer<typeof RepoStatus>;

export const PhaseName = z.enum([
  "scope",
  "discovery",
  "enrichment",
  "defense",
  "cross-linking",
  "verify",
]);
export type PhaseName = z.infer<typeof PhaseName>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: z.ZodError };

/** Validate a single ErrorEntry; collect errors rather than throwing. */
export function validateErrorEntry(input: unknown): ValidationResult<ErrorEntry> {
  const parsed = ErrorEntry.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}

/** Validate a single RepoEntry; collect errors rather than throwing. */
export function validateRepoEntry(input: unknown): ValidationResult<RepoEntry> {
  const parsed = RepoEntry.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}

/** Flatten a ZodError into `path: message` strings for logging / rejects files. */
export function flattenZodError(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
}
