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
