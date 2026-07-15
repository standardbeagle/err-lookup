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
- Prioritize production / user-facing errors.

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"errors":[{"message":"exact string","type":"exception|error_code|console|http|validation|panic","file":"path/relative/to/repo.ts","line":42,"code":"ERR_CODE_OR_NULL","errorClass":"CustomErrorOrNull","httpStatus":404}]}`;

/** Phase 2 — Enrichment (§4.2.2): batched context + fix guidance per error. */
export function enrichmentPrompt(batch: DiscoveredErrorJson[], startIndex: number): string {
  const list = batch
    .map(
      (e, i) =>
        `[${startIndex + i}] message=${JSON.stringify(e.message)} file=${e.file}:${e.line ?? "?"}${e.code ? ` code=${e.code}` : ""}`
    )
    .join("\n");
  return `Enrich each of these ${batch.length} errors. You are working in the repository root; read the source at the given file:line to ground your answer in real code.

ERRORS:
${list}

For EACH error (use the bracketed index as errorIndex) provide:
- documentation: what this error means and why this library throws it (2-4 sentences).
- triggerScenarios: the SPECIFIC conditions / API calls that produce it (not generic).
- commonSituations: real-world contexts developers hit (config mistakes, env issues, version changes).
- solutions: ordered array, most likely fix FIRST, each a concrete actionable step.
- exampleFix: before/after code block (null if not applicable).
- severity: one of critical|error|warning|info.
- tags: lowercase kebab-case array (e.g. ["network","typescript"]).

OUTPUT: return ONLY a JSON object, no prose, no markdown fences:
{"enriched":[{"errorIndex":0,"documentation":"...","triggerScenarios":"...","commonSituations":"...","solutions":["step 1","step 2"],"exampleFix":"// before\\n...\\n// after\\n...","severity":"error","tags":["x","y"]}]}`;
}
