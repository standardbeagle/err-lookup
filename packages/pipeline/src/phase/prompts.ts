/**
 * Analysis phase prompts (§4.2). Discovery + enrichment ported from v1's proven
 * prompts at apps/orchestrator/.claude/agents/*.md and adapted to the v2 schema.
 * Output shapes are explicit so extractJson + zod can validate cleanly.
 */

export interface DiscoveredErrorJson {
  message: string;
  type: string;
  file: string;
  line?: number | null;
  code?: string | null;
  errorClass?: string | null;
  httpStatus?: number | null;
}

export interface EnrichedErrorJson {
  errorIndex: number;
  documentation: string;
  triggerScenarios: string;
  commonSituations: string;
  solutions: string[];
  exampleFix?: string | null;
  severity: "critical" | "error" | "warning" | "info";
  tags: string[];
  backgroundTag?: string | null;
}

export interface DefenseStrategyJson {
  errorIndex: number;
  handlingStrategy: "try-catch" | "type-guard" | "validation" | "retry" | "fallback";
  validationCode?: string | null;
  typeGuard?: string | null;
  tryCatchPattern?: string | null;
  preventionTips: string[];
}

export interface VerifyPatchJson {
  id: string;
  field:
    | "documentation"
    | "triggerScenarios"
    | "commonSituations"
    | "solutions"
    | "exampleFix"
    | "sourceCode"
    | "filePath";
  value: unknown;
}

/**
 * Phase 1a — Candidate classification: the deterministic extractor already
 * located error-raising sites; the model verifies each against the surrounding
 * source and emits the discovery shape. One dense payload per batch — no
 * repo exploration required, which keeps lighter models accurate.
 */
export function candidateDiscoveryPrompt(
  candidates: { file: string; line: number; kind: string; snippet: string; literal: string | null; context: string | null }[]
): string {
  return `You are an expert at finding error patterns in codebases. A static scanner extracted these candidate error-raising sites from the repository (you are in its root). Each candidate carries a \`context\` excerpt of the surrounding source. Judge each candidate FROM ITS CONTEXT and decide whether it is a USER-FACING error. Only open the file when the context is insufficient — e.g. the message string clearly continues beyond the excerpt or context is null.

CANDIDATES:
${JSON.stringify(candidates)}

RULES:
- Include the EXACT error message string from source, preserving template placeholders (e.g. \`\${name}\`, {}, %s). For multi-line messages that are cut off in the context, read the file.
- Use the candidate's file and line (correct the line only if the actual throw is adjacent).
- Capture the error code when one is defined; note the error class and HTTP status where applicable.
- EXCLUDE: internal assertions never shown to users, debug logging, dead code, generated files.
- EXCLUDE demo/sample/example code: anything under samples/, examples/, demo/, getting-started/, playground/, notebooks/, or quickstart paths, and any file that is clearly a runnable walkthrough rather than the library itself (e.g. a script that configures credentials and calls the library end-to-end). Errors thrown by demo code are not errors of the library.
- Do not invent errors that are not in the candidate list.

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"errors":[{"message":"exact string","type":"exception|error_code|console|http|validation|panic","file":"path/relative/to/repo.ts","line":42,"code":"ERR_CODE_OR_NULL","errorClass":"CustomErrorOrNull","httpStatus":404}]}`;
}

/** Phase 1 — Discovery (§4.2.1): scan repo for user-facing errors. */
export const DISCOVERY_PROMPT = `You are an expert at finding error patterns in codebases. Systematically discover ALL user-facing errors in this repository.

SEARCH STRATEGY:
1. Error throwing: throw new Error(), throw new CustomError(), raise Exception, errors.New(), fmt.Errorf(), panic!()
2. Error class / type definitions extending base Error types
3. Console / logging errors with user-facing messages (console.error, log.Error, logging.error)
4. HTTP error responses: status codes 4xx/5xx with messages
5. Error constants / enums (ENOTFOUND, EINVAL, ERR_INVALID_*)
6. Validation errors: form validation, input checks, assertions

RULES:
- Include the EXACT error message string from source, preserving template placeholders (e.g. \`\${name}\`, {}, %s).
- Note the precise line number of the throw/raise.
- Capture the error code when one is defined.
- SKIP test files, mocks, fixtures, debug-only logs.
- SKIP demo/sample/example code: samples/, examples/, demo/, getting-started/, playground/, notebooks/, quickstart paths, and runnable walkthrough scripts. Errors thrown by demo code are not errors of the library.
- Prioritize production / user-facing errors.

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"errors":[{"message":"exact string","type":"exception|error_code|console|http|validation|panic","file":"path/relative/to/repo.ts","line":42,"code":"ERR_CODE_OR_NULL","errorClass":"CustomErrorOrNull","httpStatus":404}]}`;

/** Which per-error outputs a single analysis call should produce. */
export interface AnalysisNeed {
  enrichment: boolean;
  defense: boolean;
}

const ENRICHMENT_FIELDS = `- documentation: what this error means and why this library throws it (2-4 sentences).
- triggerScenarios: the SPECIFIC conditions / API calls that produce it (not generic).
- commonSituations: real-world contexts developers hit (config mistakes, env issues, version changes).
- solutions: ordered array, most likely fix FIRST, each a concrete actionable step.
- exampleFix: before/after code block (null if not applicable).
- severity: one of critical|error|warning|info.
- tags: lowercase kebab-case array (e.g. ["network","typescript"]).
- backgroundTag: ONE lowercase kebab-case tag naming the cross-library error FAMILY this
  belongs to, phrased the way a developer would search it (e.g. "connection-refused",
  "jwt-token-expired", "missing-env-var", "schema-validation-failed"). Specific enough
  that a background article could cover the family; NEVER a generic word like "error",
  "exception", or "failure". null only when no family fits.`;

const DEFENSE_FIELDS = `- handlingStrategy: exactly one of try-catch|type-guard|validation|retry|fallback.
- validationCode: code the caller can run BEFORE the API to avoid the error (null if not applicable).
- typeGuard: a language-appropriate type guard / narrowing function (null if not applicable).
- tryCatchPattern: the recommended catch pattern for this specific error (null if not applicable).
- preventionTips: array of concrete habits/checks to avoid it.`;

const ENRICHED_SHAPE = `"enriched":[{"errorIndex":0,"documentation":"...","triggerScenarios":"...","commonSituations":"...","solutions":["step 1","step 2"],"exampleFix":"// before\\n...\\n// after\\n...","severity":"error","tags":["x","y"],"backgroundTag":"connection-refused"}]`;

const DEFENSE_SHAPE = `"defenseStrategies":[{"errorIndex":0,"handlingStrategy":"try-catch","validationCode":"// ...","typeGuard":"// ...","tryCatchPattern":"// ...","preventionTips":["..."]}]`;

/**
 * Phases 2+3 — Enrichment (§4.2.2) and Defense (§4.2.3) in one call.
 *
 * Both phases ask about the same errors and require reading the same source at
 * the same file:line, so asking separately made the model re-read the repo for
 * every batch — the two phases were 79% of scan wall-clock at ~24s per error.
 * The sections are still emitted independently so a resume that needs only one
 * of them (a defense phase that failed after enrichment succeeded) does not pay
 * for the other.
 */
export function analysisPrompt(
  batch: DiscoveredErrorJson[],
  startIndex: number,
  need: AnalysisNeed,
  /** Per-error throwing region, extracted procedurally; aligned with `batch`. */
  sources?: (string | null)[]
): string {
  const list = batch
    .map((e, i) => {
      const head = `[${startIndex + i}] message=${JSON.stringify(e.message)} file=${e.file}:${e.line ?? "?"}${e.code ? ` code=${e.code}` : ""}`;
      const src = sources?.[i];
      return src ? `${head}\nSOURCE:\n${src}\n---` : head;
    })
    .join("\n");

  const sections: string[] = [];
  const shapes: string[] = [];
  if (need.enrichment) {
    sections.push(`EXPLAIN the error (for a developer who hit it):\n${ENRICHMENT_FIELDS}`);
    shapes.push(ENRICHED_SHAPE);
  }
  if (need.defense) {
    sections.push(
      `DEFEND against the error (how a USER of this library should guard against it):\n${DEFENSE_FIELDS}`
    );
    shapes.push(DEFENSE_SHAPE);
  }

  return `Analyze each of these ${batch.length} errors. You are working in the repository root. Each error includes its throwing SOURCE region — ground every answer in it. Open the file at the given file:line only when an error lacks a SOURCE block or the region is not enough (e.g. the relevant API surface sits elsewhere).

ERRORS:
${list}

For EACH error (use the bracketed index as errorIndex) provide:

${sections.join("\n\n")}

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{${shapes.join(",")}}`;
}

/** Phase 5 — Verify (§4.2.5): review assembled records for gaps, emit patches. */
export function verifyPrompt(compact: { id: string; message: string; file: string; line: number | null; hasDoc: boolean; hasSolutions: boolean; hasSource: boolean; hasDefense: boolean }[]): string {
  const list = compact
    .map(
      (c) =>
        `id=${c.id} message=${JSON.stringify(c.message)} file=${c.file}:${c.line ?? "?"} hasDoc=${c.hasDoc} hasSolutions=${c.hasSolutions} hasSource=${c.hasSource} hasDefense=${c.hasDefense}`
    )
    .join("\n");
  return `Review these assembled error records for gaps. For each record with a gap, emit a patch that fills it. Only patch fields that are missing/empty/wrong.

RECORDS:
${list}

Patchable fields and the value shapes:
- documentation (string), triggerScenarios (string), commonSituations (string)
- solutions (array of strings), exampleFix (string)
- sourceCode (string: the real throwing region, ≤40 lines, read from the file)
- filePath (string: corrected path if the recorded one is wrong)

Do NOT patch records that are already complete. Do NOT invent ids.

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"patches":[{"id":"<16 hex>","field":"documentation","value":"..."}]}`;
}
