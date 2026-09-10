import { describe, it, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { ErrorEntry } from "@errlookup/schema";
import { isThinRecord, canonicalSlugs, indexableSlugs, indexableLastmod, THIN_DOC_CHARS } from "@errlookup/schema";
import ErrorDetail from "../src/components/ErrorDetail.astro";

const LONG_DOC =
  "This error fires when the configured endpoint refuses the connection during the initial handshake, " +
  "usually because the target service is not listening yet or a firewall rewrote the port. The client " +
  "surfaces it before any request body is sent.";

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
    sourceCode: null,
    sourceCodeStart: null,
    sourceCodeEnd: null,
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
    analyzedSha: "deadbeef",
    analyzedAt: "2026-08-30T00:00:00.000Z",
    schemaVersion: 2,
    ...overrides,
  } as ErrorEntry;
}

describe("crawl-surface predicates (schema/indexing.ts)", () => {
  it("thin = short documentation AND no solutions; either alone is enough to index", () => {
    expect(isThinRecord(rec({ documentation: "stub", solutions: [] }))).toBe(true);
    expect(isThinRecord(rec({ documentation: "stub", solutions: ["fix"] }))).toBe(false);
    expect(isThinRecord(rec({ documentation: LONG_DOC, solutions: [] }))).toBe(false);
    expect(LONG_DOC.length).toBeGreaterThanOrEqual(THIN_DOC_CHARS); // fixture stays valid
  });

  it("one canonical per duplicate group: solutions beat doc length, ties break on slug", () => {
    const all = [
      rec({ slug: "v-nosol", messagePattern: "p1", solutions: [], documentation: LONG_DOC + LONG_DOC }),
      rec({ slug: "v-rich", messagePattern: "p1", solutions: ["fix"], documentation: LONG_DOC }),
      rec({ slug: "b-tie", messagePattern: "p2" }),
      rec({ slug: "a-tie", messagePattern: "p2" }),
      rec({ slug: "solo", messagePattern: "p3" }),
    ];
    const canon = canonicalSlugs(all);
    expect(canon).toEqual(new Set(["v-rich", "a-tie", "solo"]));
  });

  it("distinct error codes sharing one message template stay distinct pages", () => {
    // serverless: FUNCTION_MSK_ and FUNCTION_KAFKA_STARTING_POSITION_TIMESTAMP_
    // INVALID share their template verbatim; the pattern-only rule noindexed
    // the MSK page — the very page a live Google result was showing.
    const all = [
      rec({ slug: "msk", errorCode: "MSK_TS_INVALID", messagePattern: "shared" }),
      rec({ slug: "kafka", errorCode: "KAFKA_TS_INVALID", messagePattern: "shared", documentation: LONG_DOC + "x" }),
      rec({ slug: "same-code-a", errorCode: "DUP", messagePattern: "other-1" }),
      rec({ slug: "same-code-b", errorCode: "DUP", messagePattern: "other-2", documentation: LONG_DOC + "y" }),
    ];
    const canon = canonicalSlugs(all);
    expect(canon.has("msk")).toBe(true);
    expect(canon.has("kafka")).toBe(true);
    // ...while the same CODE thrown twice still collapses to its richest page.
    expect(canon.has("same-code-b")).toBe(true);
    expect(canon.has("same-code-a")).toBe(false);
  });

  it("indexable = canonical and not thin; variants and stubs render but earn no sitemap line", () => {
    const all = [
      rec({ slug: "good", messagePattern: "p1" }),
      rec({ slug: "variant", messagePattern: "p1" }),
      rec({ slug: "stub", messagePattern: "p2", documentation: "short", solutions: [] }),
    ];
    expect(indexableSlugs(all)).toEqual(new Set(["good"]));
  });
});

describe("sitemap lastmod rollup (indexableLastmod)", () => {
  it("is the newest content change among indexable records only", () => {
    const all = [
      rec({ slug: "good", messagePattern: "p1", contentChangedAt: "2026-09-01T00:00:00.000Z" }),
      rec({ slug: "older", messagePattern: "p2", contentChangedAt: "2026-08-01T00:00:00.000Z" }),
      // A thin stub and a non-canonical variant carry the newest date but earn
      // no sitemap line — dating the index off them would advertise a change
      // to a document that does not contain it.
      rec({ slug: "stub", messagePattern: "p3", documentation: "short", solutions: [], contentChangedAt: "2026-09-09T00:00:00.000Z" }),
      rec({ slug: "variant", messagePattern: "p1", contentChangedAt: "2026-09-08T00:00:00.000Z" }),
    ];
    expect(indexableLastmod(all)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("re-analysis that changes no content leaves the date still", () => {
    // The whole point: a drain re-analyzes hundreds of repos a day and bumps
    // analyzedAt on every record. If that moved lastmod, every bulk scan would
    // republish an index claiming ~1,400 changed sitemaps, and the crawler
    // would stop believing it.
    const before = [rec({ slug: "a", contentChangedAt: "2026-09-01T00:00:00.000Z", analyzedAt: "2026-09-01T00:00:00.000Z" })];
    const after = [rec({ slug: "a", contentChangedAt: "2026-09-01T00:00:00.000Z", analyzedAt: "2026-09-09T00:00:00.000Z" })];
    expect(indexableLastmod(after)).toBe(indexableLastmod(before));
  });

  it("falls back to analyzedAt per record when contentChangedAt predates the field", () => {
    const all = [rec({ slug: "a", contentChangedAt: null, analyzedAt: "2026-08-20T00:00:00.000Z" })];
    expect(indexableLastmod(all)).toBe("2026-08-20T00:00:00.000Z");
  });

  it("is null when nothing is indexable, so callers fall back to the repo date", () => {
    expect(indexableLastmod([rec({ slug: "stub", documentation: "short", solutions: [] })])).toBeNull();
    expect(indexableLastmod([])).toBeNull();
  });

  it("reuses a caller's indexable set instead of recomputing the grouping", () => {
    const all = [rec({ slug: "a", contentChangedAt: "2026-09-01T00:00:00.000Z" })];
    expect(indexableLastmod(all, new Set())).toBeNull();
    expect(indexableLastmod(all, new Set(["a"]))).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("noindex rendering", () => {
  it("indexable=false emits a robots noindex,follow meta; default emits none", async () => {
    const container = await AstroContainer.create();
    const e = rec({});
    const render = (indexable: boolean) =>
      container.renderToString(ErrorDetail, {
        props: { error: e, repoFullName: e.repo, related: [], indexable },
        request: new Request(`https://errors.standardbeagle.com/${e.repo}/${e.slug}/`),
      });
    expect(await render(false)).toContain('<meta name="robots" content="noindex, follow"');
    expect(await render(true)).not.toContain('name="robots"');
  });
});
