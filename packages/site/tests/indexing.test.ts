import { describe, it, expect } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { ErrorEntry } from "@errlookup/schema";
import { isThinRecord, canonicalSlugs, indexableSlugs, THIN_DOC_CHARS } from "../src/data/indexing.js";
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

describe("crawl-surface predicates (data/indexing.ts)", () => {
  it("thin = short documentation AND no solutions; either alone is enough to index", () => {
    expect(isThinRecord(rec({ documentation: "stub", solutions: [] }))).toBe(true);
    expect(isThinRecord(rec({ documentation: "stub", solutions: ["fix"] }))).toBe(false);
    expect(isThinRecord(rec({ documentation: LONG_DOC, solutions: [] }))).toBe(false);
    expect(LONG_DOC.length).toBeGreaterThanOrEqual(THIN_DOC_CHARS); // fixture stays valid
  });

  it("one canonical per message pattern: solutions beat doc length, ties break on slug", () => {
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

  it("indexable = canonical and not thin; variants and stubs render but earn no sitemap line", () => {
    const all = [
      rec({ slug: "good", messagePattern: "p1" }),
      rec({ slug: "variant", messagePattern: "p1" }),
      rec({ slug: "stub", messagePattern: "p2", documentation: "short", solutions: [] }),
    ];
    expect(indexableSlugs(all)).toEqual(new Set(["good"]));
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
