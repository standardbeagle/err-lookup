import { describe, it, expect } from "vitest";
import { assemble } from "../src/phase/assembler.js";


function enrichedWithTag(tag: unknown) {
  return new Map([
    [
      0,
      {
        errorIndex: 0,
        documentation: "d",
        triggerScenarios: "t",
        commonSituations: "c",
        solutions: ["s"],
        exampleFix: null,
        severity: "error",
        tags: [],
        backgroundTag: tag,
      } as never,
    ],
  ]);
}

function assembleWithTag(
  tag: unknown,
  opts: { pageFamilies?: Map<string, string | null>; errorClass?: string | null; message?: string } = {}
) {
  const out = assemble({
    repo: "acme/lib",
    sha: "a".repeat(40),
    repoPath: "/nonexistent",
    discovered: [{ ...discovered(null, opts.message ?? "connection refused by peer", "src/net.ts"), errorClass: opts.errorClass ?? null }],
    enriched: enrichedWithTag(tag),
    ...(opts.pageFamilies ? { pageFamilies: opts.pageFamilies } : {}),
  });
  return out.records[0] ?? null;
}

describe("assemble: the family a page is published under", () => {
  it("stores the proposal in tag shape, without publishing it", () => {
    // The old write path kept whatever the model coined, which is how one
    // corpus grew 56,960 families. A proposal now waits for a decision.
    const r = assembleWithTag(" BGP Session Flapping! ");
    expect(r?.backgroundTagRaw).toBe("bgp-session-flapping");
    expect(r?.backgroundTag).toBeNull();
  });

  it("does not publish a declared family's name just because the model proposed it", () => {
    // Whether a proposed name can be trusted as a rule is measured, not
    // assumed; until then the page waits for the classifier like any other.
    const r = assembleWithTag("connection-refused");
    expect(r?.backgroundTag).toBeNull();
    expect(r?.backgroundTagRaw).toBe("connection-refused");
  });

  it("nulls generic families and garbage — auxiliary field, never a record reject", () => {
    for (const bad of ["error", "Exception", "---", null, undefined]) {
      const r = assembleWithTag(bad);
      expect(r?.backgroundTag ?? null).toBeNull();
      expect(r?.backgroundTagRaw ?? null).toBeNull();
    }
  });

  it("settles a new page from a precise content rule", () => {
    const r = assembleWithTag("whatever", { errorClass: "ConnectionRefusedError" });
    expect(r?.backgroundTag).toBe("connection-refused");
  });

  it("keeps the family a re-analysed page was already given", () => {
    const first = assembleWithTag("bgp-session-flapping")!;
    const again = assembleWithTag("bgp-session-flapping", { pageFamilies: new Map([[first.id, "connection-reset"]]) });
    expect(again?.backgroundTag).toBe("connection-reset");
  });

  it("keeps a page the classifier placed nowhere unpublished, even against a rule", () => {
    // The decision is the later, better-informed judgment; a rule does not
    // overturn it on re-analysis.
    const first = assembleWithTag("x", { errorClass: "ConnectionRefusedError" })!;
    const again = assembleWithTag("x", { errorClass: "ConnectionRefusedError", pageFamilies: new Map([[first.id, null]]) });
    expect(again?.backgroundTag).toBeNull();
  });
});

function discovered(code: string | null, message: string, file: string) {
  return { message, type: "exception", file, line: null, code, errorClass: null, httpStatus: null };
}

describe("assemble: a code the model did not answer as a string", () => {
  it("keeps a numeric code as its digits instead of failing the whole repo", () => {
    // matomo died on `(errorCode ?? errorMessage).slice is not a function`:
    // the model answered code=111, which is a real errno, not a mistake.
    const numeric = { ...discovered("x", "connection refused", "src/net.ts"), code: 111 as unknown as string };
    const out = assemble({
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [numeric],
      enriched: new Map(),
    });

    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.errorCode).toBe("111");
    // A bare "111" is a fine id and a useless URL, so the message rides along.
    expect(out.records[0]!.slug).toBe("111-connection-refused");
  });

  it("treats a non-code shape as no code at all, and still keeps the record", () => {
    const objectCode = {
      ...discovered("x", "bad request payload", "src/http.ts"),
      code: { value: "E_BAD" } as unknown as string,
    };
    const out = assemble({
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [objectCode],
      enriched: new Map(),
    });

    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.errorCode).toBeNull();
    // Slug falls back to the message, which is the point of having one.
    expect(out.records[0]!.slug).toBe("bad-request-payload");
  });
});

describe("assemble slug uniqueness", () => {
  it("disambiguates records that derive the same slug (same code, different files)", () => {
    const out = assemble({
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [
        discovered("ERR_INVALID_STATE", "invalid state in parser", "src/parser.ts"),
        discovered("ERR_INVALID_STATE", "invalid state in lexer", "src/lexer.ts"),
      ],
      enriched: new Map(),
    });
    expect(out.records).toHaveLength(2);
    const slugs = out.records.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(2);
    // First occurrence keeps the clean slug. The collision is resolved by
    // what the code-only derivation ignored — the message — rather than by a
    // hex fragment nobody can read.
    expect(slugs[0]).toBe("err-invalid-state");
    expect(slugs[1]).toBe("err-invalid-state-in-lexer");
  });

  it("falls back to the hex fragment only when the alternative collides too", () => {
    const out = assemble({
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      // Same code, same message, three files: the alternative distinguishes
      // the second, and by the third there is nothing left to say.
      discovered: [
        discovered("ERR_SAME", "identical text", "src/a.ts"),
        discovered("ERR_SAME", "identical text", "src/b.ts"),
        discovered("ERR_SAME", "identical text", "src/c.ts"),
      ],
      enriched: new Map(),
    });
    expect(out.records[0]!.slug).toBe("err-same");
    expect(out.records[1]!.slug).toBe("err-same-identical-text");
    expect(out.records[2]!.slug).toMatch(/^err-same-[0-9a-f]{6}$/);
  });

  it("drops exact duplicate discoveries (same id) instead of failing the repo", () => {
    const dup = discovered("ERR_DUP", "duplicate thing", "src/a.ts");
    const out = assemble({
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [dup, { ...dup }],
      enriched: new Map(),
    });
    expect(out.records).toHaveLength(1);
    expect(out.rejects).toHaveLength(1);
    expect(out.rejects[0]!.error).toMatch(/duplicate/i);
    // The scan log groups rejects by the leading token of this string, so a
    // rewording here changes what operators see when a repo loses half its
    // discoveries (typecho dropped 46 of 89 on 2026-09-11).
    expect(out.rejects[0]!.error).toMatch(/^duplicate discovery/);
  });
});

describe("assemble: slugs owned by surviving published records", () => {
  it("suffixes a slug a surviving record owns; keeps it when the owner is this identity", () => {
    // integrate never deletes survivors, so a fresh record deriving an
    // un-rediscovered survivor's slug would hit the unique (repo, slug)
    // index and fail the whole integration.
    const d = discovered("ERR_TAKEN", "boom happens", "src/a.ts");
    const base = {
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [d],
      enriched: new Map(),
    };
    const free = assemble({ ...base });
    const id = free.records[0]!.id;
    expect(free.records[0]!.slug).toBe("err-taken");

    const takenByOther = assemble({ ...base, existingSlugOwners: new Map([["err-taken", "f".repeat(16)]]) });
    expect(takenByOther.records[0]!.slug).toBe("err-taken-boom-happens");

    // The same identity re-published keeps its own slug — no churn.
    const takenBySelf = assemble({ ...base, existingSlugOwners: new Map([["err-taken", id]]) });
    expect(takenBySelf.records[0]!.slug).toBe("err-taken");
  });

  it("a published record keeps its slug even when the derivation would now differ", () => {
    // This is what makes a corpus-wide re-analysis safe to schedule. Without
    // it, every improvement to deriveSlug silently re-slugs every record it
    // touches: the published URL stops existing, and each crawled copy turns
    // into a redirect paid for out of a crawl budget already down to tens of
    // requests a day.
    const d = discovered(null, "用户名或密码错误", "src/service/UmsMemberService.java");
    const base = {
      repo: "acme/lib",
      sha: "a".repeat(40),
      repoPath: "/nonexistent",
      discovered: [d],
      enriched: new Map(),
    };
    const fresh = assemble({ ...base });
    // A new record gets the improved derivation...
    expect(fresh.records[0]!.slug).toBe("umsmemberservice");

    // ...but one already published as the old "error" keeps it.
    const id = fresh.records[0]!.id;
    const republished = assemble({ ...base, existingSlugOwners: new Map([["error", id]]) });
    expect(republished.records[0]!.slug).toBe("error");
  });
});
