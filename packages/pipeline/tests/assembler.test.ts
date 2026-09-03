import { describe, it, expect } from "vitest";
import { assemble, normalizeBackgroundTag } from "../src/phase/assembler.js";

describe("normalizeBackgroundTag", () => {
  it("passes a valid kebab tag through", () => {
    expect(normalizeBackgroundTag("connection-refused")).toBe("connection-refused");
  });
  it("sanitizes case, spaces, and stray punctuation", () => {
    expect(normalizeBackgroundTag(" JWT Token Expired! ")).toBe("jwt-token-expired");
  });
  it("nulls generic families and garbage — auxiliary field, never a record reject", () => {
    expect(normalizeBackgroundTag("error")).toBeNull();
    expect(normalizeBackgroundTag("Exception")).toBeNull();
    expect(normalizeBackgroundTag("---")).toBeNull();
    expect(normalizeBackgroundTag(null)).toBeNull();
    expect(normalizeBackgroundTag(undefined)).toBeNull();
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
    expect(out.records[0]!.slug).toBe("111");
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
    // first occurrence keeps the clean slug; collision gets a stable suffix
    expect(slugs[0]).toBe("err-invalid-state");
    expect(slugs[1]).toMatch(/^err-invalid-state-[0-9a-f]{6}$/);
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
    expect(takenByOther.records[0]!.slug).toBe(`err-taken-${id.slice(0, 6)}`);

    // The same identity re-published keeps its own slug — no churn.
    const takenBySelf = assemble({ ...base, existingSlugOwners: new Map([["err-taken", id]]) });
    expect(takenBySelf.records[0]!.slug).toBe("err-taken");
  });
});
