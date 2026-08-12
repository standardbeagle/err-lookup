import {
  validateErrorEntry,
  type ErrorEntry,
  CURRENT_SCHEMA_VERSION,
} from "@errlookup/schema";
import type { DiscoveredErrorJson, EnrichedErrorJson, DefenseStrategyJson } from "./prompts.js";
import { computeErrorId, deriveSlug, normalizeErrorType } from "../util/ids.js";
import { extractSourceRegion, githubPermalink } from "../util/source.js";
import { deriveMessagePattern } from "../util/pattern.js";

/** Kebab-case tag shape (mirrors schema's Tag). */
const TAG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** Family names too generic to write a background article about. */
const GENERIC_FAMILIES = new Set(["error", "errors", "exception", "exceptions", "failure", "failures", "unknown"]);

/**
 * Normalize the model's backgroundTag to a valid, non-generic kebab tag. The
 * field is auxiliary — a malformed or generic value becomes null rather than
 * rejecting the whole record.
 */
export function normalizeBackgroundTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tag = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return TAG_RE.test(tag) && !GENERIC_FAMILIES.has(tag) ? tag : null;
}

export interface AssembleInput {
  repo: string;
  sha: string;
  /** Absolute path to the cloned working dir — used for source-code extraction. */
  repoPath: string;
  discovered: DiscoveredErrorJson[];
  enriched: Map<number, EnrichedErrorJson>;
  defense?: Map<number, DefenseStrategyJson>;
}

export interface AssembleOutput {
  records: ErrorEntry[];
  rejects: { message: string; error: string }[];
}

/**
 * Merge discovery + enrichment + defense + deterministic source extraction into
 * validated ErrorEntry records (§3.1). GitHub permalinks pinned to the analyzed
 * SHA (never branch-relative — fixes v1 bug). messagePattern derived per §4.3.
 */
export function assemble(input: AssembleInput): AssembleOutput {
  const { repo, sha, repoPath, discovered, enriched, defense } = input;
  const analyzedAt = new Date().toISOString();
  const records: ErrorEntry[] = [];
  const rejects: { message: string; error: string }[] = [];
  const seenIds = new Set<string>();
  const usedSlugs = new Set<string>();

  discovered.forEach((d, i) => {
    const filePath = d.file ?? "unknown";
    const line = typeof d.line === "number" && d.line > 0 ? d.line : null;
    const region = line != null ? extractSourceRegion(repoPath, filePath, line) : null;

    const e = enriched.get(i);
    const def = defense?.get(i);

    const id = computeErrorId({
      repo,
      errorCode: d.code ?? null,
      errorMessage: d.message,
      filePath,
    });
    if (seenIds.has(id)) {
      rejects.push({ message: d.message, error: `duplicate discovery (id ${id})` });
      return;
    }
    seenIds.add(id);

    // Slug must be unique per repo (unique index). deriveSlug collides when the
    // same errorCode is thrown from multiple files, so disambiguate with a
    // stable id fragment — deterministic across runs.
    let slug = deriveSlug(d.code ?? null, d.message);
    if (usedSlugs.has(slug)) slug = `${slug}-${id.slice(0, 6)}`;
    usedSlugs.add(slug);

    const record = {
      id,
      repo,
      slug,
      errorCode: d.code ?? null,
      errorMessage: d.message,
      messagePattern: deriveMessagePattern(d.message).pattern,
      errorType: normalizeErrorType(d.type),
      errorClass: d.errorClass ?? null,
      httpStatus: d.httpStatus ?? null,
      severity: e?.severity ?? "error",
      filePath,
      lineNumber: line,
      sourceCode: region?.sourceCode ?? null,
      sourceCodeStart: region?.start ?? null,
      sourceCodeEnd: region?.end ?? null,
      githubUrl: githubPermalink(
        repo,
        sha,
        filePath,
        region?.start ?? line,
        region?.end ?? null
      ),
      documentation: e?.documentation ?? `Error "${d.message}" thrown in ${repo}.`,
      triggerScenarios: e?.triggerScenarios ?? `Thrown at ${filePath}${line ? `:${line}` : ""} when the library encounters an invalid state.`,
      commonSituations: e?.commonSituations ?? "See trigger scenarios.",
      solutions: e?.solutions ?? [],
      exampleFix: e?.exampleFix ?? null,
      handlingStrategy: def?.handlingStrategy ?? null,
      validationCode: def?.validationCode ?? null,
      typeGuard: def?.typeGuard ?? null,
      tryCatchPattern: def?.tryCatchPattern ?? null,
      preventionTips: def?.preventionTips ?? [],
      tags: (e?.tags ?? []).map((t) => t.toLowerCase()),
      backgroundTag: normalizeBackgroundTag(e?.backgroundTag),
      analyzedSha: sha,
      analyzedAt,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    const v = validateErrorEntry(record);
    if (v.ok) records.push(v.value);
    else rejects.push({ message: d.message, error: v.error.issues.map((x) => x.path.join(".") + ": " + x.message).join("; ") });
  });

  return { records, rejects };
}
