import { describe, it, expect } from "vitest";
import type { ErrorEntry } from "@errlookup/schema";
import { canonicalSlugs } from "@errlookup/schema";
import { flagsFor, qualityRows, qualityCounts, qualitySummary } from "../src/exporter/quality.js";

const LONG_DOC = "x".repeat(400);

function rec(overrides: Partial<ErrorEntry>): ErrorEntry {
  return {
    id: "0123456789abcdef",
    repo: "a/b",
    slug: "boom",
    errorCode: null,
    errorMessage: "boom",
    messagePattern: "boom",
    errorType: "exception",
    errorClass: null,
    httpStatus: null,
    severity: "error",
    filePath: "src/a.js",
    lineNumber: 1,
    sourceCode: "throw new Error('boom')",
    sourceCodeStart: 1,
    sourceCodeEnd: 1,
    githubUrl: "https://github.com/a/b/blob/deadbeef/src/a.js#L1",
    documentation: LONG_DOC,
    triggerScenarios: "t",
    commonSituations: "c",
    solutions: ["fix it"],
    exampleFix: null,
    handlingStrategy: null,
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: [],
    tags: [],
    backgroundTag: null,
    analyzedSha: "d".repeat(40),
    analyzedAt: "2026-08-30T00:00:00.000Z",
    contentChangedAt: "2026-08-30T00:00:00.000Z",
    schemaVersion: 2,
    ...overrides,
  } as ErrorEntry;
}

/** Flags for one record judged on its own — no duplicate group to belong to. */
function flags(e: ErrorEntry): string[] {
  return flagsFor(e, canonicalSlugs([e]));
}

describe("quality flags", () => {
  it("says nothing about a healthy record", () => {
    expect(flags(rec({}))).toEqual([]);
  });

  it("separates thin from merely short: solutions carry a short doc", () => {
    expect(flags(rec({ documentation: "stub", solutions: [] }))).toContain("thin");
    expect(flags(rec({ documentation: "stub", solutions: ["fix"] }))).toContain("short-doc");
    expect(flags(rec({ documentation: "stub", solutions: ["fix"] }))).not.toContain("thin");
  });

  it("names the two slug pathologies apart", () => {
    // The CJK case: no ASCII to slug from.
    expect(flags(rec({ slug: "error" }))).toContain("generic-slug");
    expect(flags(rec({ slug: "error-39bdc1" }))).toContain("generic-slug");
    // A real slug that collided and took a hex fragment.
    expect(flags(rec({ slug: "err-bad-response-3f2a1c" }))).toContain("opaque-slug");
    expect(flags(rec({ slug: "err-bad-response-3f2a1c" }))).not.toContain("generic-slug");
    expect(flags(rec({ slug: "err-bad-response" }))).toEqual([]);
  });

  it("flags a page with no source region and one with no solutions", () => {
    expect(flags(rec({ sourceCode: null }))).toEqual(["no-source"]);
    expect(flags(rec({ solutions: [] }))).toEqual(["no-solutions"]);
  });

  it("flags the non-canonical member of a duplicate group, not the canonical one", () => {
    const canonical = rec({ slug: "rich", messagePattern: "p", solutions: ["fix"] });
    const variant = rec({ slug: "poor", messagePattern: "p", solutions: [] });
    const set = canonicalSlugs([canonical, variant]);
    expect(flagsFor(canonical, set)).toEqual([]);
    expect(flagsFor(variant, set)).toContain("duplicate");
  });
});

describe("quality stream", () => {
  const rows = qualityRows(
    new Map([
      [
        "a/b",
        [
          rec({ slug: "healthy" }),
          rec({ slug: "error", documentation: "stub", solutions: [], sourceCode: null }),
          rec({ slug: "ok-but-thin", documentation: "stub", solutions: [] }),
        ],
      ],
    ]),
    "https://example.test"
  );

  it("omits healthy records — it is a work list, not a census", () => {
    expect(rows.map((r) => r.slug)).not.toContain("healthy");
    expect(rows).toHaveLength(2);
  });

  it("sorts worst first, and each row is addressable", () => {
    expect(rows[0]!.slug).toBe("error");
    expect(rows[0]!.flags.length).toBeGreaterThan(rows[1]!.flags.length);
    expect(rows[0]!.url).toBe("https://example.test/a/b/error/");
    expect(rows[0]!.indexable).toBe(false);
  });

  it("counts every flag and reports the share of the corpus", () => {
    const { flagged, noindexed, byFlag } = qualityCounts(rows);
    expect(flagged).toBe(2);
    expect(noindexed).toBe(2);
    expect(byFlag.thin).toBe(2);
    expect(byFlag["generic-slug"]).toBe(1);
    expect(qualitySummary(3, rows)).toContain("2/3 records flagged (66.7%)");
    expect(qualitySummary(3, rows)).toContain("thin=2");
  });

  it("reports a clean corpus as clean instead of dividing by zero", () => {
    expect(qualitySummary(0, [])).toContain("0/0 records flagged (0.0%)");
    expect(qualitySummary(0, [])).toContain("none");
  });
});
