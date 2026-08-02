import { readFileSync } from "node:fs";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { extractJson } from "./json.js";

/**
 * Test double for LlmProvider: replays a recorded CLI stdout from disk (§8).
 * Identical interface to SpawningProvider so the phase runner can't tell them
 * apart. Optionally simulates a failure when `failWith` is set.
 */
export class FixtureProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly fixturePath: string,
    private readonly failWith?: { kind: "spawn" | "parse" | "timeout" | "empty"; error: string }
  ) {}

  async invoke(_prompt: string, _opts: InvokeOptions): Promise<ProviderResult> {
    if (this.failWith) return { ok: false, ...this.failWith };
    const raw = readFileSync(this.fixturePath, "utf8");
    return extractJson(raw);
  }
}

/**
 * Test double that selects a fixture by matching substrings in the prompt.
 * Used to drive discovery + analysis + verify from one provider instance in e2e.
 *
 * A route matches when EVERY string in `match` is present, so a fused prompt
 * (enrichment + defense in one call) can be routed apart from either
 * single-phase prompt. First matching route wins — list the specific ones first.
 */
export class ScriptedProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly routes: { match: string | string[]; fixturePath: string }[]
  ) {}

  async invoke(prompt: string, _opts: InvokeOptions): Promise<ProviderResult> {
    for (const r of this.routes) {
      const needles = Array.isArray(r.match) ? r.match : [r.match];
      if (needles.every((n) => prompt.includes(n))) {
        const raw = readFileSync(r.fixturePath, "utf8");
        return extractJson(raw);
      }
    }
    return { ok: false, kind: "parse", error: "no scripted route matched prompt" };
  }
}
