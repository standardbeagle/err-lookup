/**
 * Search primitives shared by the exporter (build side), the MCP server
 * (offline full-index search), and the site's Pages Function (sharded static
 * search). One tokenizer everywhere: an index built with a different
 * normalization than the query silently returns nothing.
 */

/** Compact per-error search entry (index.json and search/meta/*.json rows). */
export interface IndexError {
  id: string;
  repo: string;
  slug: string;
  code: string | null;
  msg: string;
  pattern: string;
  type: string;
  cls: string | null;
  tags: string[];
  sev: string;
}

/** Extract SCREAMING_SNAKE and E[A-Z]+ tokens (error-code candidates). */
export function extractCodeTokens(input: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of input.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) tokens.add(m[0]);
  for (const m of input.matchAll(/\bE[A-Z]+\b/g)) tokens.add(m[0]);
  return tokens;
}

/** Normalize text for fuzzy matching: lowercase, strip digits/paths/hex/quotes. */
export function normalizeForFuzzy(s: string): string {
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

// ---------------------------------------------------------------------------
// Sharded static index (§5.4) — layout constants and the query engine.
// ---------------------------------------------------------------------------

export const TOKEN_SHARDS = 256;
export const META_CHUNK = 2000;
/** idf weights and norms ship as integers: round(value * WEIGHT_SCALE). */
export const WEIGHT_SCALE = 100;
export const FUZZY_THRESHOLD = 0.4;

/** FNV-1a 32-bit — tiny, stable across JS runtimes, good enough spread. */
export function tokenShard(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % TOKEN_SHARDS;
}

export function tokenShardPath(token: string): string {
  return `search/tokens/${tokenShard(token).toString(16).padStart(2, "0")}.json`;
}

/** Error ids are 16 hex chars; their first two spread uniformly. */
export function idShard(id: string): number {
  return Number.parseInt(id.slice(0, 2), 16) % TOKEN_SHARDS;
}

export function idShardPath(id: string): string {
  return `search/ids/${idShard(id).toString(16).padStart(2, "0")}.json`;
}

/** Resolve one error id to its compact entry via the id shards. */
export async function lookupById(id: string, fetchJson: ShardJsonFetcher): Promise<IndexError | null> {
  const [summary, ids] = await Promise.all([
    fetchJson<SearchSummary>("search/summary.json"),
    fetchJson<Record<string, number>>(idShardPath(id)),
  ]);
  const idx = ids?.[id];
  if (summary == null || idx == null) return null;
  const chunk = await fetchJson<IndexError[]>(`search/meta/${Math.floor(idx / summary.metaChunk)}.json`);
  return chunk?.[idx % summary.metaChunk] ?? null;
}

export interface SearchSummary {
  entryCount: number;
  tokenShards: number;
  metaChunk: number;
  weightScale: number;
}

/** token -> [scaledIdf, [entryIdx, ...]] */
export type TokenShardFile = Record<string, [number, number[]]>;

export interface ShardedHit {
  entry: IndexError;
  score: number;
  matchType: "exact-code" | "fuzzy";
}

/** Read-side interface: fetch a dataset-relative JSON file, null on miss. */
export type ShardJsonFetcher = <T>(relPath: string) => Promise<T | null>;

export interface SearchIndexFile {
  relPath: string;
  content: string;
}

/**
 * Build the sharded static index from the compact entry list. Emits ~260
 * fixed-count files regardless of dataset size:
 *
 *   search/summary.json      SearchSummary
 *   search/codes.json        errorCode -> [entryIdx]
 *   search/ids/<hh>.json     errorId -> entryIdx (sharded by id prefix)
 *   search/tokens/<hh>.json  token -> [scaledIdf, [entryIdx, ...]]
 *   search/norms.json        entryIdx -> scaled vector norm (dense array)
 *   search/meta/<k>.json     entries [k*META_CHUNK, (k+1)*META_CHUNK)
 */
export function buildSearchIndex(entries: IndexError[]): SearchIndexFile[] {
  const df = new Map<string, number>();
  const tokensByEntry: Set<string>[] = entries.map((e) => {
    const tokens = new Set(normalizeForFuzzy(e.msg).split(" ").filter(Boolean));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });
  const N = entries.length || 1;
  const idfOf = (t: string): number => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const shards: Map<string, [number, number[]]>[] = Array.from({ length: TOKEN_SHARDS }, () => new Map());
  const norms = new Array<number>(entries.length).fill(0);
  tokensByEntry.forEach((tokens, idx) => {
    let sq = 0;
    for (const t of tokens) {
      const w = idfOf(t);
      sq += w * w;
      const shard = shards[tokenShard(t)]!;
      const posting = shard.get(t) ?? [Math.round(w * WEIGHT_SCALE), []];
      posting[1].push(idx);
      shard.set(t, posting);
    }
    norms[idx] = Math.round(Math.sqrt(sq) * WEIGHT_SCALE);
  });

  const codes = new Map<string, number[]>();
  entries.forEach((e, idx) => {
    if (!e.code) return;
    const list = codes.get(e.code) ?? [];
    list.push(idx);
    codes.set(e.code, list);
  });

  const idShards: Record<string, number>[] = Array.from({ length: TOKEN_SHARDS }, () => ({}));
  entries.forEach((e, idx) => {
    idShards[idShard(e.id)]![e.id] = idx;
  });

  const files: SearchIndexFile[] = [
    {
      relPath: "search/summary.json",
      content: JSON.stringify({
        entryCount: entries.length,
        tokenShards: TOKEN_SHARDS,
        metaChunk: META_CHUNK,
        weightScale: WEIGHT_SCALE,
      } satisfies SearchSummary),
    },
    { relPath: "search/codes.json", content: JSON.stringify(Object.fromEntries(codes)) },
    { relPath: "search/norms.json", content: JSON.stringify(norms) },
  ];
  shards.forEach((shard, i) => {
    files.push({
      relPath: `search/tokens/${i.toString(16).padStart(2, "0")}.json`,
      content: JSON.stringify(Object.fromEntries(shard)),
    });
  });
  idShards.forEach((m, i) => {
    files.push({ relPath: `search/ids/${i.toString(16).padStart(2, "0")}.json`, content: JSON.stringify(m) });
  });
  for (let k = 0; k * META_CHUNK < entries.length || k === 0; k++) {
    files.push({
      relPath: `search/meta/${k}.json`,
      content: JSON.stringify(entries.slice(k * META_CHUNK, (k + 1) * META_CHUNK)),
    });
  }
  return files;
}

/**
 * Tiered search over the sharded static index. Fetch cost is O(query): one
 * token shard per distinct query token, codes.json only when the query carries
 * code-shaped tokens, meta chunks only for the top candidates. The dense
 * norms.json is the single index-sized file — ~1 byte-digit per entry — and
 * callers should cache it (and summary/codes) across queries.
 *
 * Tier semantics vs the offline searcher: exact-code is identical; the regex
 * pattern tier is folded into token scoring (a static shard cannot run 150k
 * regexes); fuzzy is cosine over the same normalized tokens and idf weighting
 * the offline Jaccard uses.
 */
export async function shardedSearch(
  input: string,
  fetchJson: ShardJsonFetcher,
  opts: { repo?: string; limit?: number } = {}
): Promise<ShardedHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 25));
  const summary = await fetchJson<SearchSummary>("search/summary.json");
  if (!summary || summary.entryCount === 0) return [];

  const metaCache = new Map<number, IndexError[]>();
  const metaFor = async (idx: number): Promise<IndexError | null> => {
    const k = Math.floor(idx / summary.metaChunk);
    if (!metaCache.has(k)) {
      metaCache.set(k, (await fetchJson<IndexError[]>(`search/meta/${k}.json`)) ?? []);
    }
    return metaCache.get(k)![idx % summary.metaChunk] ?? null;
  };

  const hits: ShardedHit[] = [];
  const taken = new Set<number>();

  // Tier 1 — exact code.
  const codeTokens = extractCodeTokens(input);
  if (codeTokens.size > 0) {
    const codes = await fetchJson<Record<string, number[]>>("search/codes.json");
    for (const t of codeTokens) {
      for (const idx of codes?.[t] ?? []) {
        if (taken.has(idx)) continue;
        const entry = await metaFor(idx);
        if (!entry) continue;
        if (opts.repo && entry.repo !== opts.repo) continue;
        taken.add(idx);
        hits.push({ entry, score: 1, matchType: "exact-code" });
      }
    }
  }

  // Tier 2 — cosine over token postings.
  const qTokens = [...new Set(normalizeForFuzzy(input).split(" ").filter(Boolean))];
  if (qTokens.length > 0 && hits.length < limit) {
    const shardPaths = [...new Set(qTokens.map(tokenShardPath))];
    const shardByPath = new Map<string, TokenShardFile | null>();
    await Promise.all(
      shardPaths.map(async (p) => shardByPath.set(p, await fetchJson<TokenShardFile>(p)))
    );

    const scores = new Map<number, number>();
    let qNormSq = 0;
    const maxIdf = Math.log(summary.entryCount + 1) + 1;
    for (const t of qTokens) {
      const posting = shardByPath.get(tokenShardPath(t))?.[t];
      const idf = posting ? posting[0] / summary.weightScale : maxIdf;
      qNormSq += idf * idf;
      if (!posting) continue;
      for (const idx of posting[1]) {
        scores.set(idx, (scores.get(idx) ?? 0) + idf * idf);
      }
    }
    const qNorm = Math.sqrt(qNormSq);

    const norms = await fetchJson<number[]>("search/norms.json");
    const ranked = [...scores.entries()]
      .map(([idx, dot]) => {
        const eNorm = (norms?.[idx] ?? 0) / summary.weightScale;
        return { idx, score: eNorm > 0 && qNorm > 0 ? dot / (eNorm * qNorm) : 0 };
      })
      .filter((c) => c.score >= FUZZY_THRESHOLD && !taken.has(c.idx))
      .sort((a, b) => b.score - a.score);

    for (const c of ranked) {
      if (hits.length >= limit) break;
      const entry = await metaFor(c.idx);
      if (!entry) continue;
      if (opts.repo && entry.repo !== opts.repo) continue;
      hits.push({ entry, score: Math.min(1, c.score), matchType: "fuzzy" });
    }
  }

  return hits.slice(0, limit);
}
