import { describe, it, expect } from "vitest";
import { assemble } from "../src/phase/assembler.js";
import { buildTagIndex } from "@errlookup/schema";

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

function assembleWithTag(tag: unknown, index = new Map<string, string>()) {
  const out = assemble({
    repo: "acme/lib",
    sha: "a".repeat(40),
    repoPath: "/nonexistent",
    discovered: [discovered(null, "connection refused by peer", "src/net.ts")],
    enriched: enrichedWithTag(tag),
    tagIndex: index,
  });
  return out.records[0]?.backgroundTag ?? null;
}

describe("assemble: backgroundTag reaches the record as a family name", () => {
  it("sanitizes case, spaces, and stray punctuation", () => {
    expect(assembleWithTag(" JWT Token Expired! ")).toBe("jwt-token-expired");
  });

  it("nulls generic families and garbage — auxiliary field, never a record reject", () => {
    for (const bad of ["error", "Exception", "---", null, undefined]) {
      expect(assembleWithTag(bad)).toBeNull();
    }
  });

  it("folds a coined name onto the established family", () => {
    // The prompt asks the model to reuse a family; this is what makes the
    // stored record honour it when the model phrases it its own way.
    const index = buildTagIndex([
      { tag: "missing-env-var", errorCount: 945, repoCount: 40, infoSlug: "missing-env-var" },
    ]);
    expect(assembleWithTag("environment-variable-missing", index)).toBe("missing-env-var");
  });

  it("keeps a family the corpus has never seen", () => {
    const index = buildTagIndex([
      { tag: "missing-env-var", errorCount: 945, repoCount: 40, infoSlug: null },
    ]);
    expect(assembleWithTag("bgp-session-flapping", index)).toBe("bgp-session-flapping");
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
