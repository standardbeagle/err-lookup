import { describe, it, expect } from "vitest";
import {
  normalizeTag,
  tagKey,
  resolveTag,
  buildTagIndex,
  TAG_ALIASES,
  GENERIC_FAMILIES,
  type TagFamily,
} from "../src/tags.js";

function vocab(...rows: [string, number][]): TagFamily[] {
  return rows.map(([tag, errorCount]) => ({ tag, errorCount, repoCount: 2, infoSlug: null }));
}

describe("normalizeTag", () => {
  it("kebabs whatever the model wrote", () => {
    expect(normalizeTag("Connection Refused")).toBe("connection-refused");
    expect(normalizeTag("JWT_TOKEN_EXPIRED")).toBe("jwt-token-expired");
    expect(normalizeTag("  --missing--env--var-- ")).toBe("missing-env-var");
  });

  it("drops names that describe nothing", () => {
    for (const g of GENERIC_FAMILIES) expect(normalizeTag(g)).toBeNull();
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag(null)).toBeNull();
  });

  it("applies the hand-maintained aliases", () => {
    expect(normalizeTag("missing-required-field")).toBe("missing-required-argument");
    expect(normalizeTag("Invalid Argument Type")).toBe("invalid-argument-value");
  });

  it("every alias target is a spelling the corpus actually uses", () => {
    // A target nobody writes means the merge renames every member onto a new
    // name and orphans whatever article the old names had.
    for (const target of new Set(Object.values(TAG_ALIASES))) {
      expect(TAG_ALIASES[target], `${target} is itself aliased`).toBeUndefined();
    }
  });

  it("every alias target is itself a usable tag, and no alias chains", () => {
    for (const [alias, target] of Object.entries(TAG_ALIASES)) {
      expect(normalizeTag(target), `${target} must normalize to itself`).toBe(target);
      expect(TAG_ALIASES[target], `${alias} -> ${target} must not chain`).toBeUndefined();
    }
  });
});

describe("tagKey", () => {
  it("ignores word order, plurals, abbreviations and filler", () => {
    const key = tagKey("missing-env-var");
    expect(tagKey("missing-environment-variable")).toBe(key);
    expect(tagKey("env-vars-missing")).toBe(key);
    expect(tagKey("missing-environment-variables-error")).toBe(key);
  });

  it("keeps genuinely different families apart", () => {
    expect(tagKey("connection-refused")).not.toBe(tagKey("connection-reset"));
    expect(tagKey("jwt-token-expired")).not.toBe(tagKey("jwt-token-invalid"));
  });

  it("is empty when the name is only filler", () => {
    expect(tagKey("the-error")).toBe("");
  });

  it("carries an alias's own spelling variants to the target", () => {
    // The variants are the point: aliasing only the exact string would leave
    // "required-field-missing" behind with its own family and its own article.
    const target = tagKey("missing-required-argument");
    expect(tagKey("missing-required-field")).toBe(target);
    expect(tagKey("required-field-missing")).toBe(target);
    expect(tagKey("missing-required-fields")).toBe(target);
    expect(tagKey("missing-required-param")).toBe(target);
  });
});

describe("resolveTag", () => {
  const index = buildTagIndex(
    vocab(["missing-env-var", 945], ["schema-validation-failed", 1873], ["connection-refused", 120])
  );

  it("returns the established spelling for the same family", () => {
    expect(resolveTag("environment-variable-missing", index)).toBe("missing-env-var");
    expect(resolveTag("Missing Environment Variables", index)).toBe("missing-env-var");
  });

  it("keeps a genuinely new family", () => {
    expect(resolveTag("bgp-session-flapping", index)).toBe("bgp-session-flapping");
  });

  it("rejects what normalizeTag rejects", () => {
    expect(resolveTag("exception", index)).toBeNull();
    expect(resolveTag(undefined, index)).toBeNull();
  });

  it("is idempotent — resolving its own output changes nothing", () => {
    for (const t of ["environment-variable-missing", "bgp-session-flapping", "schema-validation-error"]) {
      const once = resolveTag(t, index);
      expect(resolveTag(once, index)).toBe(once);
    }
  });
});

describe("buildTagIndex", () => {
  it("makes the largest family the canonical spelling", () => {
    const index = buildTagIndex(vocab(["env-var-missing", 12], ["missing-env-var", 945]));
    expect(resolveTag("missing-environment-variable", index)).toBe("missing-env-var");
  });

  it("a hand-written alias outranks the record count", () => {
    // missing-required-field is the bigger family here, and still loses: the
    // count is why the group exists, the alias is the decision about its name.
    const index = buildTagIndex(vocab(["missing-required-field", 9000], ["missing-required-argument", 3]));
    expect(resolveTag("missing-required-field", index)).toBe("missing-required-argument");
    expect(resolveTag("required-field-missing", index)).toBe("missing-required-argument");
  });

  it("breaks count ties on the name so builds are reproducible", () => {
    const index = buildTagIndex(vocab(["b-token-expired", 5], ["a-token-expired", 5]));
    expect(index.get(tagKey("a-token-expired"))).toBe("a-token-expired");
  });
});
