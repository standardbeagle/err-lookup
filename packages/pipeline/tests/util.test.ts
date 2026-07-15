import { describe, it, expect } from "vitest";
import { withTimeout, TimeoutError, sleep } from "../src/util/watchdog.js";
import { computeErrorId, deriveSlug, normalizeErrorType } from "../src/util/ids.js";
import { extractSourceRegion, githubPermalink } from "../src/util/source.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

describe("watchdog", () => {
  it("resolves before timeout", async () => {
    const r = await withTimeout(Promise.resolve("ok"), 1000);
    expect(r).toBe("ok");
  });

  it("rejects with TimeoutError when exceeded", async () => {
    await expect(withTimeout(sleep(500), 30)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("ids", () => {
  it("computeErrorId is deterministic + 16 hex", () => {
    const id = computeErrorId({
      repo: "axios/axios",
      errorCode: "ERR_BAD_RESPONSE",
      errorMessage: "x",
      filePath: "lib/core/settle.js",
    });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const id2 = computeErrorId({
      repo: "axios/axios",
      errorCode: "ERR_BAD_RESPONSE",
      errorMessage: "x",
      filePath: "lib/core/settle.js",
    });
    expect(id2).toBe(id);
  });

  it("uses message when no code; different file → different id", () => {
    const a = computeErrorId({ repo: "r/r", errorCode: null, errorMessage: "boom", filePath: "a.js" });
    const b = computeErrorId({ repo: "r/r", errorCode: null, errorMessage: "boom", filePath: "b.js" });
    expect(a).not.toBe(b);
  });

  it("deriveSlug kebab-codes and truncates", () => {
    expect(deriveSlug("ERR_BAD_RESPONSE", "x")).toBe("err-bad-response");
    expect(deriveSlug(null, "Cannot find module 'foo'")).toBe("cannot-find-module-foo");
  });

  it("normalizeErrorType maps known + defaults to exception", () => {
    expect(normalizeErrorType("HTTP")).toBe("http");
    expect(normalizeErrorType("panic")).toBe("panic");
    expect(normalizeErrorType("error_code")).toBe("error_code");
    expect(normalizeErrorType("weird")).toBe("exception");
    expect(normalizeErrorType(null)).toBe("exception");
  });
});

describe("source region", () => {
  it("extracts a ≤40 line window around the throw line", () => {
    const dir = resolve(".tmp-src-test");
    mkdirSync(dir, { recursive: true });
    const file = "sample.js";
    writeFileSync(
      resolve(dir, file),
      Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
    );
    const r = extractSourceRegion(dir, file, 50)!;
    expect(r).not.toBeNull();
    const lineCount = r.sourceCode.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(40);
    expect(r.start).toBeLessThanOrEqual(50);
    expect(r.end).toBeGreaterThanOrEqual(50);
    expect(r.end - r.start + 1).toBeLessThanOrEqual(40);
  });

  it("returns null when file missing", () => {
    expect(extractSourceRegion("/no/such", "x.js", 5)).toBeNull();
  });

  it("githubPermalink pins SHA + range anchor", () => {
    const url = githubPermalink("axios/axios", "abc123", "lib/x.js", 10, 20);
    expect(url).toBe("https://github.com/axios/axios/blob/abc123/lib/x.js#L10-L20");
    const single = githubPermalink("r/r", "sha", "f.js", 7, null);
    expect(single).toBe("https://github.com/r/r/blob/sha/f.js#L7");
  });
});
