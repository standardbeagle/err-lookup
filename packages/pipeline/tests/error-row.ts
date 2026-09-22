import type { errors } from "../src/db/schema.js";

type ErrorInsert = typeof errors.$inferInsert;

let seq = 0;

/**
 * A complete, valid errors row with a fresh hex id, for tests that care
 * about a few fields. Ids are hex like production's, so code that slices or
 * prefixes them sees what it will see in the corpus.
 */
export function errorRow(over: Partial<ErrorInsert> = {}): ErrorInsert {
  const n = seq++;
  const id = (0x1000000 + n).toString(16).padStart(16, "0");
  return {
    id,
    repo: "org/lib",
    slug: `boom-${id}`,
    errorCode: null,
    errorMessage: `boom ${n}`,
    messagePattern: "boom",
    errorType: "exception",
    errorClass: null,
    httpStatus: null,
    severity: "error",
    filePath: "src/a.js",
    lineNumber: 1,
    sourceCode: null,
    sourceCodeStart: null,
    sourceCodeEnd: null,
    githubUrl: "https://github.com/a/b/blob/x/src/a.js#L1",
    documentation: "d",
    triggerScenarios: "t",
    commonSituations: "",
    solutions: ["s"],
    exampleFix: null,
    handlingStrategy: null,
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: [],
    tags: [],
    backgroundTag: null,
    backgroundTagRaw: null,
    analyzedSha: "a".repeat(40),
    analyzedAt: "2026-08-11T00:00:00Z",
    schemaVersion: 2,
    ...over,
  };
}
