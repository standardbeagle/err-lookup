import type { IndexError } from "./cache.js";
import { siteErrorUrl } from "./base-url.js";

export interface SearchHit {
  id: string;
  repo: string;
  code: string | null;
  message: string;
  score: number;
  matchType: "exact-code" | "pattern" | "fuzzy";
  url: string;
}

export interface SearchOptions {
  repo?: string;
  limit?: number;
}

const PATTERN_BUDGET_MS = 50;
const FUZZY_THRESHOLD = 0.4;

/** Extract SCREAMING_SNAKE and E[A-Z]+ tokens (error-code candidates) from input. */
function extractCodeTokens(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of input.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) tokens.add(m[0]);
  for (const m of input.matchAll(/\bE[A-Z]+\b/g)) tokens.add(m[0]);
  return tokens;
}

/** Tier 1 — exact-code: an input token equals an entry's errorCode. */
function tierExactCode(input: string, errors: IndexError[]): IndexError[] {
  const tokens = extractCodeTokens(input);
  if (tokens.size === 0) return [];
  return errors.filter((e) => e.code !== null && tokens.has(e.code));
}

/** Tier 2 — pattern: test input against each messagePattern regex (bounded). */
function tierPattern(input: string, errors: IndexError[]): IndexError[] {
  const start = Date.now();
  const hits: IndexError[] = [];
  for (const e of errors) {
    if (e.pattern.length > 500) continue;
    if (Date.now() - start > PATTERN_BUDGET_MS) break;
    try {
      if (new RegExp(e.pattern).test(input)) hits.push(e);
    } catch {
      // invalid pattern — skip
    }
  }
  return hits;
}

/** Normalize text for fuzzy matching: lowercase, strip digits/paths/hex/quotes. */
function normalizeForFuzzy(s: string): string {
  return s
    .toLowerCase()
    .replace(/\/[\w./-]+/g, " ") // paths
    .replace(/0x[0-9a-f]+/g, " ") // hex
    .replace(/\b\d+\b/g, " ") // numbers
    .replace(/'[^']*'|"[^"]*"/g, " ") // quoted strings
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Precompute IDF over the index for rare-token boosting. */
function buildIdf(errors: IndexError[]): Map<string, number> {
  const df = new Map<string, number>();
  const N = errors.length || 1;
  for (const e of errors) {
    const seen = new Set(normalizeForFuzzy(e.msg).split(" ").filter(Boolean));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((N + 1) / (d + 1)) + 1);
  return idf;
}

/** Tier 3 — fuzzy: weighted Jaccard over normalized tokens with IDF boost. */
function tierFuzzy(input: string, errors: IndexError[], idf: Map<string, number>): { entry: IndexError; score: number }[] {
  const inTokens = new Set(normalizeForFuzzy(input).split(" ").filter(Boolean));
  if (inTokens.size === 0) return [];
  const scored: { entry: IndexError; score: number }[] = [];
  for (const e of errors) {
    const eTokens = new Set(normalizeForFuzzy(e.msg).split(" ").filter(Boolean));
    if (eTokens.size === 0) continue;
    let inter = 0;
    let union = 0;
    const all = new Set([...inTokens, ...eTokens]);
    for (const t of all) {
      const w = idf.get(t) ?? 1;
      const inA = inTokens.has(t);
      const inB = eTokens.has(t);
      if (inA && inB) inter += w;
      union += w;
    }
    const score = union > 0 ? inter / union : 0;
    if (score >= FUZZY_THRESHOLD) scored.push({ entry: e, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function toHit(e: IndexError, score: number, matchType: SearchHit["matchType"]): SearchHit {
  return {
    id: e.id,
    repo: e.repo,
    code: e.code,
    message: e.msg,
    score,
    matchType,
    url: siteErrorUrl(e.repo, e.slug),
  };
}

/**
 * Tiered matching (§7.3). First tier with hits wins; matchType reports which.
 * `repo` filter restricts every tier. Scores ∈ [0,1].
 */
export function searchErrors(input: string, errors: IndexError[], opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 5;
  const pool = opts.repo ? errors.filter((e) => e.repo === opts.repo) : errors;
  if (pool.length === 0) return [];

  // Tier 1: exact-code
  const code = tierExactCode(input, pool);
  if (code.length > 0) {
    return dedupe(code.map((e) => toHit(e, 1.0, "exact-code"))).slice(0, limit);
  }

  // Tier 2: pattern
  const pat = tierPattern(input, pool);
  if (pat.length > 0) {
    return dedupe(pat.map((e) => toHit(e, 0.9, "pattern"))).slice(0, limit);
  }

  // Tier 3: fuzzy
  const idf = buildIdf(pool);
  const fuzzy = tierFuzzy(input, pool, idf);
  if (fuzzy.length > 0) {
    return dedupe(fuzzy.map((f) => toHit(f.entry, round(f.score), "fuzzy"))).slice(0, limit);
  }

  return [];
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const h of hits) if (!seen.has(h.id)) seen.set(h.id, h);
  return [...seen.values()];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
