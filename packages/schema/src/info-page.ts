import { z } from "zod";
import { ErrorId, Slug, IsoUtc, type ValidationResult } from "./error.js";

/**
 * Info pages — cross-repo background articles the collector generates from
 * clusters of related error records (§ info-collector). Where an error page
 * documents one throw site, an info page covers the whole family: how often it
 * appears across the corpus, the common causes distilled from every record's
 * documentation, and which failure-class guides go deeper.
 */

export const INFO_PAGE_SCHEMA_VERSION = 1 as const;

export const InfoCause = z.object({
  cause: z.string().min(1),
  detail: z.string().min(1),
});
export type InfoCause = z.infer<typeof InfoCause>;

export const InfoPageEntry = z
  .object({
    slug: Slug,
    /** Idempotency key for the collector: "code:ECONNREFUSED" / "class:TypeError". */
    clusterKey: z.string().min(1),
    title: z.string().min(1),
    /** One-paragraph answer — what this error family is. */
    summary: z.string().min(1),
    /** The background a single error page cannot give: mechanism, where it sits in the stack. */
    background: z.string().min(1),
    commonCauses: z.array(InfoCause).min(1),
    /** Remediation themes that hold across the family (per-record fixes stay on error pages). */
    fixes: z.array(z.string().min(1)),
    /** Failure-class guides that go deeper; slugs from the GUIDES registry. */
    guideSlugs: z.array(Slug),
    /** Representative documented occurrences (capped; counts carry the true size). */
    errorIds: z.array(ErrorId).min(1),
    errorCount: z.number().int().positive(),
    repoCount: z.number().int().positive(),
    generatedAt: IsoUtc,
    schemaVersion: z.literal(INFO_PAGE_SCHEMA_VERSION),
  })
  .strict();
export type InfoPageEntry = z.infer<typeof InfoPageEntry>;

/** Compact hub/index row — everything /info/ needs without loading each page. */
export const InfoPageIndexEntry = z
  .object({
    slug: Slug,
    title: z.string().min(1),
    summary: z.string().min(1),
    errorCount: z.number().int().positive(),
    repoCount: z.number().int().positive(),
    generatedAt: IsoUtc,
  })
  .strict();
export type InfoPageIndexEntry = z.infer<typeof InfoPageIndexEntry>;

export function validateInfoPageEntry(input: unknown): ValidationResult<InfoPageEntry> {
  const parsed = InfoPageEntry.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}
