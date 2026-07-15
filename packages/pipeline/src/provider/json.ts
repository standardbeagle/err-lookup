/**
 * Extract the first parseable JSON value from a CLI's raw stdout (§4.1).
 *
 * CLIs wrap payloads in markdown fences, prose preambles, or provider envelopes
 * (e.g. `claude -p --output-format json` emits `{"type":"result","result":"<text>"}`).
 * Strategy: parse, unwrap known string-bearing envelope fields, else try a fenced
 * ```json block, else scan for the first `{`/`[` that parses. Never fabricate.
 *
 * Returns { ok:true, parsed, raw } on success or { ok:false, kind:'parse'|'empty' }.
 */
import type { ProviderResult } from "./types.js";

/**
 * Unwrap provider envelopes: if `v` is an object with a string `result`/`content`
 * field whose value is itself JSON, descend into it. Bounded to avoid loops.
 */
function unwrapEnvelope(v: unknown, depth = 0): unknown {
  if (depth > 4 || typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  for (const key of ["result", "content", "text", "message"]) {
    const inner = o[key];
    if (typeof inner === "string" && (inner.trim().startsWith("{") || inner.trim().startsWith("["))) {
      try {
        return unwrapEnvelope(JSON.parse(inner), depth + 1);
      } catch {
        // not JSON; leave as-is
      }
    }
  }
  return v;
}

export function extractJson(raw: string): ProviderResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, kind: "empty", error: "provider returned empty output" };

  // 1) Fenced code block (```json ... ``` or ``` ... ```)
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const candidate = fence[1].trim();
    try {
      return { ok: true, raw, parsed: unwrapEnvelope(JSON.parse(candidate)) };
    } catch {
      // fall through to scan
    }
  }

  // 2) Direct parse (clean JSON) + envelope unwrap
  try {
    return { ok: true, raw, parsed: unwrapEnvelope(JSON.parse(trimmed)) };
  } catch {
    // fall through to scan
  }

  // 3) Scan: find first `{` or `[` whose suffix parses. Advance on failure.
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c !== "{" && c !== "[") continue;
    const slice = trimmed.slice(i);
    try {
      return { ok: true, raw, parsed: unwrapEnvelope(JSON.parse(slice)) };
    } catch {
      const last = c === "{" ? trimmed.lastIndexOf("}") : trimmed.lastIndexOf("]");
      if (last > i) {
        try {
          return { ok: true, raw, parsed: unwrapEnvelope(JSON.parse(trimmed.slice(i, last + 1))) };
        } catch {
          // keep scanning
        }
      }
    }
  }

  return {
    ok: false,
    kind: "parse",
    error: `no JSON found in output (first 200 chars): ${trimmed.slice(0, 200)}`,
  };
}
