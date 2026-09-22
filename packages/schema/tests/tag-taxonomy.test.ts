import { describe, it, expect } from "vitest";
import {
  CANONICAL_FAMILIES,
  CANONICAL_TAGS,
  FAMILY_CHOICE_LIMIT,
  isCanonicalFamily,
  familyCriteria,
} from "../src/tag-taxonomy.js";
import { tagKey, normalizeTag, canonicalName, TAG_ALIASES, GENERIC_FAMILIES } from "../src/tags.js";

describe("canonical taxonomy", () => {
  it("fits in one Choice question", () => {
    // The whole list is offered as the options of a single classification, so
    // the model's 255-option cap (less the "none of these" slot) is the real
    // ceiling on how many families may exist.
    expect(CANONICAL_FAMILIES.length).toBeLessThanOrEqual(FAMILY_CHOICE_LIMIT);
  });

  it("names every family in stored tag shape", () => {
    for (const f of CANONICAL_FAMILIES) {
      expect(normalizeTag(f.tag), f.tag).toBe(f.tag);
      expect(GENERIC_FAMILIES.has(f.tag), f.tag).toBe(false);
    }
  });

  it("has no two families the resolver would treat as one", () => {
    // Two names with the same key are the same family to resolveTag, so the
    // second could never be reached: every record proposing it would be
    // folded onto the first.
    const byKey = new Map<string, string>();
    for (const f of CANONICAL_FAMILIES) {
      const key = tagKey(f.tag);
      expect(key, f.tag).not.toBe("");
      const clash = byKey.get(key);
      expect(clash, `${f.tag} and ${clash} share the key "${key}"`).toBeUndefined();
      byKey.set(key, f.tag);
    }
  });

  it("files every family under a domain", () => {
    for (const f of CANONICAL_FAMILIES) expect(f.domain, f.tag).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it("lists each family once", () => {
    expect(new Set(CANONICAL_FAMILIES.map((f) => f.tag)).size).toBe(CANONICAL_FAMILIES.length);
  });

  it("carries a rubric that says more than the name", () => {
    for (const f of CANONICAL_FAMILIES) {
      expect(f.criteria.length, f.tag).toBeGreaterThan(40);
      // A rubric is read by a classifier that sees no other context; one that
      // only restates the family name gives it nothing to choose on.
      const words = f.tag.split("-");
      const restated = words.every((w) => f.criteria.toLowerCase().includes(w));
      expect(restated && f.criteria.length < 80, f.tag).toBe(false);
    }
  });

  it("settles on itself under the spelling fold", () => {
    // A canonical name that is also an alias source would be rewritten the
    // moment it was stored.
    for (const f of CANONICAL_FAMILIES) {
      expect(canonicalName(f.tag), f.tag).toBe(f.tag);
    }
  });

  it("points every hand-written alias at a canonical family", () => {
    for (const [alias, target] of Object.entries(TAG_ALIASES)) {
      expect(CANONICAL_TAGS.has(target), `${alias} → ${target}`).toBe(true);
      expect(CANONICAL_TAGS.has(alias), `alias ${alias} is also canonical`).toBe(false);
    }
  });

  it("answers membership and rubric lookups", () => {
    expect(isCanonicalFamily("file-not-found")).toBe(true);
    expect(isCanonicalFamily("file-vanished-mysteriously")).toBe(false);
    expect(isCanonicalFamily(null)).toBe(false);
    expect(familyCriteria("file-not-found")).toContain("does not exist");
    expect(familyCriteria("file-vanished-mysteriously")).toBeNull();
  });
});
