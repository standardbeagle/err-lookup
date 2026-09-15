import { describe, it, expect } from "vitest";
import { titleMessage, metaDescription, truncateAtWord } from "../src/data/seo.js";

describe("titleMessage", () => {
  it("cuts at the placeholder and closes what it left dangling", () => {
    // The live case: 756 impressions in 28 days, the highest on the site, and
    // its title read "…(code {process.ExitCode}). Output: {tail}".
    expect(titleMessage("llama-server exited during startup (code {process.ExitCode}). Output: {tail}")).toBe(
      "llama-server exited during startup"
    );
    // Cutting alone would leave "(code" — an unbalanced bracket reads worse
    // than the placeholder it replaced.
    expect(titleMessage("failed to set clock time (clock_id={clock_id:?}, x)")).toBe("failed to set clock time");
  });

  it("drops placeholders in place when too little precedes them", () => {
    expect(titleMessage("Invalid SOCKS port: {}")).toBe("Invalid SOCKS port");
    expect(titleMessage("Invalid timeoutMs: ${String(value)}")).toBe("Invalid timeoutMs");
    expect(titleMessage('Unable to find table named "${tableName}"')).toBe("Unable to find table named");
  });

  it("leaves a message without placeholders alone", () => {
    const m = "Cannot attach stdin to a tty-enabled container";
    expect(titleMessage(m)).toBe(m);
  });

  it("never returns empty, whatever the message is", () => {
    for (const m of ["{}", "%s", "${x}", "<tag>"]) {
      expect(titleMessage(m).length, `${m} produced an empty title`).toBeGreaterThan(0);
    }
  });
});

describe("metaDescription", () => {
  it("leads with meaning and carries the first fix", () => {
    const d = metaDescription("It fires when the port is out of range. More detail here.", ["Clamp the port to 1-65535."]);
    expect(d).toBe("It fires when the port is out of range. Fix: Clamp the port to 1-65535.");
  });

  it("falls back to the explanation when there is no solution", () => {
    expect(metaDescription("Only this sentence.", [])).toBe("Only this sentence.");
  });

  it("cuts on a word boundary, never mid-word", () => {
    const d = metaDescription(
      "The port value was outside the accepted range for this socket type.",
      ["Clamp the configured port to the range 1 to 65535 before connecting."],
      60
    );
    expect(d.endsWith("…")).toBe(true);
    // The character before the ellipsis ends a word, so the cut fell on a space.
    expect(d.slice(0, -1)).toBe(d.slice(0, -1).trimEnd());
    expect(d.length).toBeLessThanOrEqual(61);
  });

  it("hard-cuts a single word longer than the budget — nothing else is possible", () => {
    const d = metaDescription("x".repeat(80), [], 40);
    expect(d).toBe("x".repeat(40) + "…");
  });
});

describe("truncateAtWord", () => {
  it("returns short input untouched", () => {
    expect(truncateAtWord("short", 60)).toBe("short");
  });
  it("does not strand punctuation before the ellipsis", () => {
    expect(truncateAtWord("one two three, four five", 15)).toBe("one two three…");
  });
});
