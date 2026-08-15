import { describe, it, expect } from "vitest";
import { classifyUa, trafficDataPoint, recordTraffic } from "../src/analytics.js";

describe("classifyUa", () => {
  it("separates the crawler classes the site actually serves", () => {
    expect(classifyUa("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe("googlebot");
    expect(classifyUa("GoogleOther")).toBe("google-other");
    expect(classifyUa("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe("bingbot");
    expect(classifyUa("GPTBot/1.0")).toBe("ai-bot");
    expect(classifyUa("Mozilla/5.0 (compatible; ClaudeBot/1.0)")).toBe("ai-bot");
    expect(classifyUa("PerplexityBot/1.0")).toBe("ai-bot");
    expect(classifyUa("SomeRandomCrawler/3.0")).toBe("other-bot");
    expect(classifyUa("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")).toBe("human");
    expect(classifyUa(null)).toBe("unknown");
  });
});

describe("trafficDataPoint", () => {
  it("uses the stable blob layout with the path as sampling index", () => {
    const p = trafficDataPoint(
      new URL("https://errors.standardbeagle.com/docker/cli/some-error-abc/"),
      "GPTBot/1.0",
      200,
      "hit"
    );
    expect(p.blobs).toEqual(["/docker/cli/some-error-abc/", "ai-bot", "hit", "errors.standardbeagle.com"]);
    expect(p.doubles).toEqual([200]);
    expect(p.indexes).toEqual(["/docker/cli/some-error-abc/"]);
  });

  it("caps the index at 96 bytes (AE hard limit)", () => {
    const long = "/x/" + "a".repeat(300);
    const p = trafficDataPoint(new URL(`https://h.test${long}`), null, 404, "-");
    expect(p.indexes[0]!.length).toBe(96);
    expect(p.blobs[0]!.length).toBe(256);
  });
});

describe("recordTraffic", () => {
  it("writes one point and survives a throwing dataset", () => {
    const points: unknown[] = [];
    recordTraffic({ writeDataPoint: (p) => void points.push(p) }, new URL("https://h.test/a"), "GPTBot", 200, "miss");
    expect(points).toHaveLength(1);
    expect(() =>
      recordTraffic(
        { writeDataPoint: () => { throw new Error("quota"); } },
        new URL("https://h.test/a"),
        null,
        200,
        "-"
      )
    ).not.toThrow();
    expect(() => recordTraffic(undefined, new URL("https://h.test/a"), null, 200, "-")).not.toThrow();
  });
});
