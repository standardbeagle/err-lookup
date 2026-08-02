import { describe, it, expect } from "vitest";
import { withTimeout, TimeoutError, sleep } from "../src/util/watchdog.js";
import { mapPool, chunk, Semaphore } from "../src/util/pool.js";
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

describe("mapPool", () => {
  it("keeps input order while completing out of order", async () => {
    const delays = [40, 5, 30, 1, 20];
    const out = await mapPool(delays, 3, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency limit", async () => {
    let live = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      live++;
      peak = Math.max(peak, live);
      await sleep(5);
      live--;
    });
    expect(peak).toBe(4);
  });

  it("actually runs concurrently", async () => {
    const started = Date.now();
    await mapPool(Array.from({ length: 8 }, (_, i) => i), 8, () => sleep(50));
    expect(Date.now() - started).toBeLessThan(200); // serial would be ~400ms
  });

  it("handles an empty list and a limit below one", async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
  });
});

describe("chunk", () => {
  it("splits into fixed-size groups with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
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

describe("github repo metadata", () => {
  it("parses the fields RepoEntry needs and tolerates junk", async () => {
    const { parseRepoMeta } = await import("../src/vcs/github-meta.js");
    expect(
      parseRepoMeta({ description: "d", language: "Rust", stargazers_count: 42, default_branch: "trunk" })
    ).toEqual({ description: "d", language: "Rust", stars: 42, defaultBranch: "trunk" });
    expect(parseRepoMeta({})).toEqual({ description: null, language: null, stars: 0, defaultBranch: "main" });
    expect(parseRepoMeta(null)).toBeNull();
    expect(parseRepoMeta("nope")).toBeNull();
  });
});

describe("Semaphore", () => {
  it("caps concurrent holders at the limit", async () => {
    const gate = new Semaphore(3);
    let live = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const release = await gate.acquire();
        live++;
        peak = Math.max(peak, live);
        await sleep(5);
        live--;
        release();
      })
    );
    expect(peak).toBe(3);
    expect(gate.free).toBe(3); // every slot handed back
  });

  it("hands a freed slot to the longest waiter", async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    const first = await gate.acquire();
    const queued = [1, 2, 3].map(async (n) => {
      const release = await gate.acquire();
      order.push(n);
      release();
    });
    first();
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  it("ignores a double release rather than inventing a slot", async () => {
    const gate = new Semaphore(2);
    const release = await gate.acquire();
    release();
    release();
    expect(gate.free).toBe(2);
  });
});
