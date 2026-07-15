import {
  validateErrorEntry,
  type ErrorEntry,
  CURRENT_SCHEMA_VERSION,
} from "@errlookup/schema";
import type { DiscoveredErrorJson, EnrichedErrorJson } from "./prompts.js";
import { computeErrorId, deriveSlug, normalizeErrorType } from "../util/ids.js";
import { extractSourceRegion, githubPermalink } from "../util/source.js";

/** Escape a string as a literal regex (M2 placeholder; full derivation in M3 §4.3). */
export function escapeLiteralPattern(message: string): string {
  return message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AssembleInput {
  repo: string;
  sha: string;
  /** Absolute path to the cloned working dir — used for source-code extraction. */
  repoPath: string;
  discovered: DiscoveredErrorJson[];
  enriched: Map<number, EnrichedErrorJson>;
}

export interface AssembleOutput {
  records: ErrorEntry[];
  rejects: { message: string; error: string }[];
}

/**
 * Merge discovery + enrichment + deterministic source extraction into validated
 * ErrorEntry records (§3.1). GitHub permalinks pinned to the analyzed SHA (never
 * branch-relative — fixes v1 bug). Missing enrichment is backfilled with minimal
 * valid placeholders so records pass schema; the verify phase later patches gaps.
 */
export function assemble(input: AssembleInput): AssembleOutput {
  const { repo, sha, repoPath, discovered, enriched } = input;
  const analyzedAt = new Date().toISOString();
  const records: ErrorEntry[] = [];
  const rejects: { message: string; error: string }[] = [];

  discovered.forEach((d, i) => {
    const filePath = d.file ?? "unknown";
    const line = typeof d.line === "number" && d.line > 0 ? d.line : null;
    const region = line != null ? extractSourceRegion(repoPath, filePath, line) : null;

    const e = enriched.get(i);

    const record = {
      id: computeErrorId({
        repo,
        errorCode: d.code ?? null,
        errorMessage: d.message,
        filePath,
      }),
      repo,
      slug: deriveSlug(d.code ?? null, d.message),
      errorCode: d.code ?? null,
      errorMessage: d.message,
      messagePattern: escapeLiteralPattern(d.message),
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
      handlingStrategy: null,
      validationCode: null,
      typeGuard: null,
      tryCatchPattern: null,
      preventionTips: [],
      tags: (e?.tags ?? []).map((t) => t.toLowerCase()),
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
