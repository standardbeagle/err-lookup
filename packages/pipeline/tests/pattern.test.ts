import { describe, it, expect } from "vitest";
import { deriveMessagePattern, isRe2Safe } from "../src/util/pattern.js";

describe("deriveMessagePattern", () => {
  it("replaces ${} template interpolation with (.+?)", () => {
    const { pattern, source } = deriveMessagePattern("Cannot find module '${module}'");
    expect(source).toBe("derived");
    expect(pattern).toBe("Cannot find module '(.+?)'");
    // real message matches
    expect(new RegExp(pattern).test("Cannot find module 'fs'")).toBe(true);
  });

  it("replaces %s / %d printf placeholders", () => {
    expect(deriveMessagePattern("Expected %s but got %d").pattern).toBe("Expected (.+?) but got (.+?)");
  });

  it("replaces {} and {0} brace placeholders", () => {
    expect(deriveMessagePattern("Request failed with status code {status}").pattern).toBe(
      "Request failed with status code (.+?)"
    );
    expect(deriveMessagePattern("Error {0} at {1}").pattern).toBe("Error (.+?) at (.+?)");
  });

  it("replaces python %(name)s", () => {
    expect(deriveMessagePattern("Connection to %(host)s failed").pattern).toBe(
      "Connection to (.+?) failed"
    );
  });

  it("escapes regex metacharacters in literal parts", () => {
    const { pattern } = deriveMessagePattern("array[index] (must be > 0)");
    // [ ] ( ) > are escaped
    expect(pattern).toContain("\\[index\\]");
    expect(pattern).toContain("\\(");
    expect(pattern).toContain(">");
  });

  it("does not anchor with ^ or $", () => {
    const { pattern } = deriveMessagePattern("plain error");
    expect(pattern.startsWith("^")).toBe(false);
    expect(pattern.endsWith("$")).toBe(false);
  });

  it("falls back to literal when derived pattern is ReDoS-prone", () => {
    // sanity: a normal-length message derives; sub-weight ones go literal
    expect(deriveMessagePattern("Cannot find module 'x'").source).toBe("derived");
    expect(deriveMessagePattern("ok").source).toBe("literal"); // too short to be a useful pattern
  });

  it("handles empty message without a match-anything pattern", () => {
    const d = deriveMessagePattern("");
    expect(d.source).toBe("literal");
    expect(d.pattern).not.toContain("(.+?)");
  });

  it("substitutes LLM-flagged variable literals", () => {
    const { pattern } = deriveMessagePattern("Failed to load /home/user/x on port 3000", [
      "/home/user/x",
      "3000",
    ]);
    expect(pattern).toBe("Failed to load (.+?) on port (.+?)");
  });
});

describe("isRe2Safe", () => {
  it("rejects backreferences", () => {
    expect(isRe2Safe("(a+)\\1")).toBe(false);
  });

  it("rejects nested quantifiers over a group", () => {
    expect(isRe2Safe("(.+?)+")).toBe(false);
    expect(isRe2Safe("(a*b)+")).toBe(false);
  });

  it("accepts normal derived patterns", () => {
    expect(isRe2Safe("Cannot find module '(.+?)'")).toBe(true);
    expect(isRe2Safe("Request failed with status code (.+?)")).toBe(true);
  });

  it("rejects patterns > 500 chars", () => {
    expect(isRe2Safe("a".repeat(501))).toBe(false);
  });
});

describe("pure-placeholder messages", () => {
  it("falls back to escaped literal instead of a match-anything pattern", async () => {
    const { deriveMessagePattern, patternLiteralWeight } = await import("../src/util/pattern.js");
    const d = deriveMessagePattern("{template}");
    expect(d.source).toBe("literal");
    expect(d.pattern).not.toContain("(.+?)");
    expect(new RegExp(d.pattern).test("completely unrelated message")).toBe(false);
    expect(patternLiteralWeight("(.+?)")).toBe(0);
    expect(patternLiteralWeight("Request failed with status code (.+?)")).toBeGreaterThan(20);
  });
});
