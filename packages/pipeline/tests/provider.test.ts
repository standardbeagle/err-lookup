import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson } from "../src/provider/json.js";
import { FixtureProvider } from "../src/provider/fixture.js";
import { runProvider, RATE_LIMIT_BACKOFF_MS, usageLimitResetAt } from "../src/provider/run.js";
import { ProviderError, type LlmProvider } from "../src/provider/types.js";
import { mapConfig, type ErrlookupConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(__dirname, "..", "fixtures");
const fx = (name: string) => resolve(fixtureDir, name);
const read = (name: string) => readFileSync(fx(name), "utf8");

describe("extractJson", () => {
  it("parses clean JSON", () => {
    const r = extractJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed).toEqual({ a: 1 });
  });

  it("parses fenced ```json block", () => {
    const r = extractJson(read("provider-stdout-fenced.txt"));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.parsed as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it("parses after prose preamble", () => {
    const r = extractJson(read("provider-stdout-preamble.txt"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = r.parsed as { errors: { message: string }[] };
      expect(parsed.errors[0]!.message).toContain("Cannot find module");
    }
  });

  it("rejects truncated JSON", () => {
    const r = extractJson(read("provider-stdout-truncated.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("parse");
  });

  it("reports empty output", () => {
    const r = extractJson(read("provider-stdout-empty.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("empty");
  });

  it("unwraps provider envelope {result: \"<json string>\"}", () => {
    const r = extractJson(read("provider-stdout-envelope.json"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = r.parsed as { errors: { message: string }[] };
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]!.message).toContain("Expected a function");
    }
  });
});

describe("FixtureProvider", () => {
  it("replays a fixture as parsed JSON", async () => {
    const p = new FixtureProvider("claude", fx("provider-stdout-clean.json"));
    const r = await p.invoke("prompt", { cwd: process.cwd() });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.parsed as { errors: unknown[] }).errors).toHaveLength(2);
  });

  it("simulates failure when failWith set", async () => {
    const p = new FixtureProvider("claude", fx("provider-stdout-clean.json"), {
      kind: "timeout",
      error: "boom",
    });
    const r = await p.invoke("prompt", { cwd: process.cwd() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("timeout");
  });
});

function makeCfg(primary: string, fallback?: string): ErrlookupConfig {
  // KDL requires newlines (or semicolons) between sibling nodes — keep multiline.
  const src = [
    `provider "${primary}" { command "${primary}" }`,
    fallback ? `provider "${fallback}" { command "${fallback}" }` : "",
    "defaults {",
    `  primary "${primary}"`,
    fallback ? `  fallback "${fallback}"` : "",
    "}",
  ]
    .filter(Boolean)
    .join("\n");
  return mapConfig(parseKdl(src));
}

describe("runProvider retry + fallback", () => {
  it("returns on primary first try", async () => {
    const cfg = makeCfg("p", "f");
    const providers: Record<string, LlmProvider> = {
      p: new FixtureProvider("p", fx("provider-stdout-clean.json")),
      f: new FixtureProvider("f", fx("provider-stdout-clean.json")),
    };
    const res = await runProvider("q", { cwd: "." }, providers, cfg);
    expect(res.providerUsed).toBe("p");
  });

  it("retries primary once then succeeds", async () => {
    let calls = 0;
    const fallbackFx = new FixtureProvider("f", fx("provider-stdout-clean.json"));
    const providers: Record<string, LlmProvider> = {
      p: {
        name: "p",
        async invoke() {
          calls++;
          if (calls === 1) return { ok: false as const, kind: "parse" as const, error: "bad" };
          return fallbackFx.invoke("", { cwd: "." });
        },
      },
      f: fallbackFx,
    };
    const cfg = makeCfg("p", "f");
    const res = await runProvider("q", { cwd: "." }, providers, cfg);
    expect(res.providerUsed).toBe("p");
    expect(calls).toBe(2);
  });

  it("does not repeat a timed-out call at the same size", async () => {
    let calls = 0;
    const providers: Record<string, LlmProvider> = {
      p: {
        name: "p",
        async invoke() {
          calls++;
          return { ok: false as const, kind: "timeout" as const, error: "p exceeded 600000ms" };
        },
      },
    };
    await expect(runProvider("q", { cwd: "." }, providers, makeCfg("p"))).rejects.toBeInstanceOf(ProviderError);
    // One attempt, not two: the second would spend the same input tokens over
    // the same budget to be killed again. The caller splits its batch instead.
    expect(calls).toBe(1);
  });

  it("still reaches the fallback after a timeout", async () => {
    const fallbackFx = new FixtureProvider("f", fx("provider-stdout-clean.json"));
    const providers: Record<string, LlmProvider> = {
      p: {
        name: "p",
        async invoke() {
          return { ok: false as const, kind: "timeout" as const, error: "p exceeded 600000ms" };
        },
      },
      f: fallbackFx,
    };
    const res = await runProvider("q", { cwd: "." }, providers, makeCfg("p", "f"));
    expect(res.providerUsed).toBe("f");
  });

  it("falls back when primary fails twice", async () => {
    const cfg = makeCfg("p", "f");
    const providers: Record<string, LlmProvider> = {
      p: new FixtureProvider("p", fx("provider-stdout-truncated.txt")),
      f: new FixtureProvider("f", fx("provider-stdout-clean.json")),
    };
    const res = await runProvider("q", { cwd: "." }, providers, cfg);
    expect(res.providerUsed).toBe("f");
  });

  it("throws ProviderError when both providers fail", async () => {
    const cfg = makeCfg("p", "f");
    const providers: Record<string, LlmProvider> = {
      p: new FixtureProvider("p", fx("provider-stdout-truncated.txt")),
      f: new FixtureProvider("f", fx("provider-stdout-truncated.txt")),
    };
    await expect(runProvider("q", { cwd: "." }, providers, cfg)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("usageLimitResetAt", () => {
  const msg =
    "glm ACP failure: Internal error: Usage limit reached for 5 hour. " +
    "Your limit will reset at 2026-08-23 22:00:28; stderr: Error handling request {";

  it("clamps a reset that is further away than the window is long", () => {
    // z.ai states Beijing time with no zone marker: on 2026-08-23 it named
    // 22:00:28 and calls resumed at 14:15 UTC. Holding until 22:00 UTC would
    // have idled the drain for eight hours it did not need to.
    const now = Date.parse("2026-08-23T09:00:00Z");
    expect(usageLimitResetAt(msg, now)?.toISOString()).toBe("2026-08-23T14:00:28.000Z");
  });

  it("keeps the stated minute when clamping, because zones move whole hours", () => {
    // Quota spent at 09:07 → the five-hour ceiling is 14:07, but the message
    // said the window turns at :00:28, and that part of it is zone-proof.
    const now = Date.parse("2026-08-23T09:07:00Z");
    expect(usageLimitResetAt(msg, now)?.toISOString()).toBe("2026-08-23T14:00:28.000Z");
  });

  it("never returns a hold in the past when snapping the minute back", () => {
    // Ceiling 14:00:10 snaps back to 14:00:28 — fine — but a ceiling of
    // 14:00:00 with a stated :59 would snap behind the ceiling, so it rolls on.
    const late = msg.replace("22:00:28", "22:59:00");
    const now = Date.parse("2026-08-23T09:00:30Z");
    const at = usageLimitResetAt(late, now)!;
    expect(at.getTime()).toBeGreaterThan(now);
    expect(at.getUTCMinutes()).toBe(59);
  });

  it("takes the stated time when it falls inside the window", () => {
    const now = Date.parse("2026-08-23T20:00:00Z");
    expect(usageLimitResetAt(msg, now)?.toISOString()).toBe("2026-08-23T22:00:28.000Z");
  });

  it("is null for anything that is not a spent window", () => {
    expect(usageLimitResetAt("Rate limit reached for requests")).toBeNull();
    expect(usageLimitResetAt("glm exceeded 600000ms")).toBeNull();
  });
});

describe("runProvider rate-limit backoff", () => {
  const rateLimited = {
    ok: false as const,
    kind: "spawn" as const,
    error: "glm ACP failure: AI_APICallError: Rate limit reached for requests",
  };

  /** Fails the first `failures` calls with `failure`, then answers cleanly. */
  function failingThen(name: string, failures: number, failure: typeof rateLimited): LlmProvider & { calls: number } {
    const good = new FixtureProvider(name, fx("provider-stdout-clean.json"));
    return {
      name,
      calls: 0,
      async invoke(prompt, opts) {
        return ++this.calls <= failures ? failure : good.invoke(prompt, opts);
      },
    };
  }

  it("pauses before retrying a rate-limited primary", async () => {
    const sleeps: number[] = [];
    const p = failingThen("p", 1, rateLimited);
    const res = await runProvider("q", { cwd: "." }, { p }, makeCfg("p"), undefined, async (ms) => {
      sleeps.push(ms);
    });
    expect(res.providerUsed).toBe("p");
    expect(p.calls).toBe(2);
    expect(sleeps).toEqual([RATE_LIMIT_BACKOFF_MS]);
  });

  it("retries other failure kinds without pausing", async () => {
    const sleeps: number[] = [];
    const p = failingThen("p", 1, { ok: false as const, kind: "parse" as const, error: "bad JSON" });
    const res = await runProvider("q", { cwd: "." }, { p }, makeCfg("p"), undefined, async (ms) => {
      sleeps.push(ms);
    });
    expect(res.providerUsed).toBe("p");
    expect(sleeps).toEqual([]);
  });

  it("reaches the fallback with only the same-provider backoff", async () => {
    const sleeps: number[] = [];
    const p = failingThen("p", 99, rateLimited);
    const f = new FixtureProvider("f", fx("provider-stdout-clean.json"));
    const res = await runProvider("q", { cwd: "." }, { p, f }, makeCfg("p", "f"), undefined, async (ms) => {
      sleeps.push(ms);
    });
    expect(res.providerUsed).toBe("f");
    // One pause between the two primary attempts; none before the fallback,
    // which is a different provider and not gated by the primary's limit.
    expect(sleeps).toEqual([RATE_LIMIT_BACKOFF_MS]);
  });
});
