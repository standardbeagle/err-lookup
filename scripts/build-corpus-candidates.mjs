#!/usr/bin/env node
/**
 * Emit ranked corpus candidates for expansion (§11: 111 → 1k repos).
 *
 * Queries GitHub search for the top-starred repos per language family the
 * extractor covers, drops what the corpus already lists, and writes
 * docs/corpus-candidates.txt — a reviewable list, NOT an automatic corpus:
 * curation (dedupe of forks/mirrors, licence sanity, "is this a library
 * people actually hit errors from") stays human.
 *
 *   node scripts/build-corpus-candidates.mjs [--per-language 120]
 *
 * Unauthenticated GitHub search allows 10 requests/min; with 9 languages ×
 * 2 pages this run takes ~2 minutes. Set GITHUB_TOKEN to go faster.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = resolve(ROOT, "docs", "blitz-corpus.txt");
const OUT = resolve(ROOT, "docs", "corpus-candidates.txt");

const LANGUAGES = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C#",
  "PHP",
  "Ruby",
];

const perLanguage = Number(
  process.argv[process.argv.indexOf("--per-language") + 1] > 0
    ? process.argv[process.argv.indexOf("--per-language") + 1]
    : 120
);

const existing = new Set(
  readFileSync(CORPUS, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
);

const headers = { "user-agent": "errlookup-corpus-builder" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function searchPage(language, page) {
  const q = encodeURIComponent(`language:"${language}" stars:>500 archived:false`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`;
  for (;;) {
    const res = await fetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const waitMs = Math.max(5_000, reset - Date.now() + 1_000);
      console.error(`rate limited; waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`GitHub search ${res.status} for ${language} p${page}`);
    return (await res.json()).items ?? [];
  }
}

const sections = [];
let total = 0;
for (const language of LANGUAGES) {
  const items = [];
  for (let page = 1; items.length < perLanguage && page <= 3; page++) {
    const batch = await searchPage(language, page);
    if (batch.length === 0) break;
    items.push(...batch);
  }
  const fresh = items
    .filter((r) => !existing.has(r.full_name))
    .filter((r) => !r.fork)
    .slice(0, perLanguage);
  total += fresh.length;
  sections.push(
    `# ${language} — top-starred, not yet in blitz-corpus.txt\n` +
      fresh.map((r) => `${r.full_name}  # ★${r.stargazers_count} ${String(r.description ?? "").slice(0, 60)}`).join("\n")
  );
  console.error(`${language}: ${fresh.length} candidates`);
}

writeFileSync(
  OUT,
  `# Corpus expansion candidates — generated ${new Date().toISOString()}\n` +
    `# Review, trim comments, and append keepers to docs/blitz-corpus.txt.\n` +
    `# Order matters there: the drain claims top-down, giant repos go last.\n\n` +
    sections.join("\n\n") +
    "\n"
);
console.error(`wrote ${total} candidates to ${OUT}`);
