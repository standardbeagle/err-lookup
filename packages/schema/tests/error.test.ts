import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  ErrorEntry,
  RepoEntry,
  ErrorId,
  RepoCoord,
  Slug,
  Tag,
  GitSha,
  validateErrorEntry,
  validateRepoEntry,
  flattenZodError,
  CURRENT_SCHEMA_VERSION,
} from "../src/index.js";
import type { ErrorEntry as ErrorEntryT } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..", "fixtures");

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), "utf8"));
}

/** Strip `$`-prefixed annotation keys (e.g. `$comment`) before strict validation. */
function clean<T>(rec: T): T {
  if (rec && typeof rec === "object" && !Array.isArray(rec)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
      if (!k.startsWith("$")) out[k] = v;
    }
    return out as T;
  }
  return rec;
}

/** Deep clone + apply a mutation to the valid ErrorEntry fixture. */
function mutateError(fn: (rec: Record<string, unknown>) => void): unknown {
  const rec = structuredClone(clean(loadJson("error-valid.json"))) as Record<string, unknown>;
  fn(rec);
  return rec;
}

function expectInvalid(input: unknown, fragment?: string) {
  const r = ErrorEntry.safeParse(input);
  expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(false);
  if (fragment && !r.success) {
    // Strict-mode unknown keys live in params/message, not on .path — search both.
    const hay = r.error.issues
      .map((i) => `${i.path.join(".")}\u0001${i.message}\u0001${JSON.stringify(i.params ?? {})}`)
      .join("\n");
    expect(hay, hay).toContain(fragment);
  }
}

// ---------------------------------------------------------------------------
// Fixtures accepted
// ---------------------------------------------------------------------------

describe("fixtures valid", () => {
  it("accepts error-valid.json", () => {
    const rec = mutateError(() => {});
    const r = ErrorEntry.safeParse(rec);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("accepts repo-valid.json", () => {
    const rec = clean(loadJson("repo-valid.json"));
    const r = RepoEntry.safeParse(rec);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });

  it("schemaVersion is locked to CURRENT_SCHEMA_VERSION", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    const rec = mutateError((r) => {
      r.schemaVersion = 3;
    });
    expectInvalid(rec, "schemaVersion");
  });
});

// ---------------------------------------------------------------------------
// Primitive regex rejections
// ---------------------------------------------------------------------------

describe("primitive regex schemas", () => {
  it("ErrorId rejects non-hex / wrong length", () => {
    expect(ErrorId.safeParse("XYZ12345").success).toBe(false);
    expect(ErrorId.safeParse("a1b2c3d4").success).toBe(false); // 8 chars
    expect(ErrorId.safeParse("a1b2c3d4e5f60718").success).toBe(true);
  });

  it("RepoCoord requires owner/name", () => {
    expect(RepoCoord.safeParse("axios").success).toBe(false);
    expect(RepoCoord.safeParse("axios/axios/extra").success).toBe(false);
    expect(RepoCoord.safeParse("axios axios").success).toBe(false);
    expect(RepoCoord.safeParse("axios/axios").success).toBe(true);
  });

  it("Slug rejects uppercase / leading hyphen", () => {
    expect(Slug.safeParse("ERR_BAD").success).toBe(false);
    expect(Slug.safeParse("-bad").success).toBe(false);
    expect(Slug.safeParse("err-bad-response").success).toBe(true);
  });

  it("Tag requires lowercase kebab", () => {
    expect(Tag.safeParse("CamelCase").success).toBe(false);
    expect(Tag.safeParse("HTTP").success).toBe(false);
    expect(Tag.safeParse("network").success).toBe(true);
    expect(Tag.safeParse("node-js").success).toBe(true);
  });

  it("GitSha requires 40 hex", () => {
    expect(GitSha.safeParse("abc123").success).toBe(false);
    expect(GitSha.safeParse("2e88108521a8e1c0b9b0ed8f5a04b29c21c2e9fc").success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ErrorEntry mutated-invalid rejections (spec §8.1)
// ---------------------------------------------------------------------------

describe("ErrorEntry rejects invalid variants", () => {
  it("rejects bad id", () => {
    expectInvalid(mutateError((r) => (r.id = "NOT_HEX")), "id");
  });

  it("rejects bad repo", () => {
    expectInvalid(mutateError((r) => (r.repo = "no-slash")), "repo");
  });

  it("rejects bad slug", () => {
    expectInvalid(mutateError((r) => (r.slug = "UPPER")), "slug");
  });

  it("rejects bad errorCode empty string (must be null or non-empty)", () => {
    expectInvalid(mutateError((r) => (r.errorCode = "")), "errorCode");
  });

  it("rejects empty errorMessage", () => {
    expectInvalid(mutateError((r) => (r.errorMessage = "")), "errorMessage");
  });

  it("rejects empty messagePattern", () => {
    expectInvalid(mutateError((r) => (r.messagePattern = "")), "messagePattern");
  });

  it("rejects unknown errorType", () => {
    expectInvalid(mutateError((r) => (r.errorType = "fatal")), "errorType");
  });

  it("rejects httpStatus below 100 / above 599", () => {
    expectInvalid(mutateError((r) => (r.httpStatus = 99)), "httpStatus");
    expectInvalid(mutateError((r) => (r.httpStatus = 600)), "httpStatus");
  });

  it("rejects unknown severity", () => {
    expectInvalid(mutateError((r) => (r.severity = "fatal")), "severity");
  });

  it("rejects empty filePath", () => {
    expectInvalid(mutateError((r) => (r.filePath = "")), "filePath");
  });

  it("rejects lineNumber < 1", () => {
    expectInvalid(mutateError((r) => (r.lineNumber = 0)), "lineNumber");
  });

  it("rejects sourceCode > 40 lines", () => {
    expectInvalid(
      mutateError((r) => {
        r.sourceCode = Array.from({ length: 41 }, (_, i) => `line ${i}`).join("\n");
      }),
      "sourceCode"
    );
  });

  it("rejects sourceCodeEnd < sourceCodeStart", () => {
    expectInvalid(
      mutateError((r) => {
        r.sourceCodeStart = 20;
        r.sourceCodeEnd = 10;
      }),
      "sourceCodeEnd"
    );
  });

  it("rejects malformed githubUrl", () => {
    expectInvalid(mutateError((r) => (r.githubUrl = "not-a-url")), "githubUrl");
  });

  it("rejects empty documentation", () => {
    expectInvalid(mutateError((r) => (r.documentation = "")), "documentation");
  });

  it("rejects empty-string entries in solutions", () => {
    expectInvalid(
      mutateError((r) => {
        r.solutions = ["valid", ""];
      }),
      "solutions"
    );
  });

  it("rejects unknown handlingStrategy", () => {
    expectInvalid(mutateError((r) => (r.handlingStrategy = "crash")), "handlingStrategy");
  });

  it("rejects bad tag", () => {
    expectInvalid(
      mutateError((r) => {
        r.tags = ["network", "CamelCase"];
      }),
      "tags"
    );
  });

  it("rejects malformed analyzedSha", () => {
    expectInvalid(mutateError((r) => (r.analyzedSha = "deadbeef")), "analyzedSha");
  });

  it("rejects non-UTC analyzedAt", () => {
    expectInvalid(mutateError((r) => (r.analyzedAt = "yesterday")), "analyzedAt");
    expectInvalid(mutateError((r) => (r.analyzedAt = "2026-07-14 00:00:00")), "analyzedAt");
  });

  it("rejects unknown key (strict)", () => {
    expectInvalid(
      mutateError((r) => {
        r.totallyNewField = "nope";
      }),
      "totallyNewField"
    );
  });

  it("rejects missing required field", () => {
    const rec = mutateError(() => {}) as Record<string, unknown>;
    delete rec.documentation;
    expectInvalid(rec, "documentation");
  });

  it("accepts errorCode=null and errorClass=null", () => {
    const rec = mutateError((r) => {
      r.errorCode = null;
      r.errorClass = null;
    });
    expect(ErrorEntry.safeParse(rec).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("validation helpers", () => {
  it("validateErrorEntry returns ok branch", () => {
    const rec = mutateError(() => {});
    const r = validateErrorEntry(rec);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as ErrorEntryT).errorCode).toBe("ERR_BAD_RESPONSE");
  });

  it("validateErrorEntry returns error branch on invalid", () => {
    const r = validateErrorEntry(mutateError((x) => (x.id = "bad")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(flattenZodError(r.error).length).toBeGreaterThan(0);
  });

  it("validateRepoEntry returns ok branch", () => {
    const r = validateRepoEntry(clean(loadJson("repo-valid.json")));
    expect(r.ok).toBe(true);
  });

  it("flattenZodError emits path: message strings", () => {
    const r = validateErrorEntry(mutateError((x) => (x.id = "bad")));
    if (!r.ok) {
      const lines = flattenZodError(r.error);
      expect(lines.some((l) => l.startsWith("id:"))).toBe(true);
    }
  });
});
