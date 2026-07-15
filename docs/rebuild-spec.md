# err-lookup v2 — Rebuild Specification

**Status:** Draft for implementation
**Audience:** Autonomous coding agent (GLM 5.2) rebuilding from scratch
**Date:** 2026-07-14

---

## 1. Purpose & Positioning

Build a machine-consumable **error knowledge base** for open-source libraries, with a human-readable static site as a secondary surface.

Primary consumers, in priority order:

1. **AI coding agents** — via an MCP server that answers "what is this error and how do I fix it" at runtime.
2. **AI answer engines** — via clean, crawlable JSON + `llms.txt` so answers cite the site (AEO).
3. **Humans searching error messages** — via the static site (SEO long tail).

This is a pivot from v1, which was a per-repo Docusaurus microsite SEO play. That approach is dead: fragmented domain authority, scaled AI content penalties, and error queries moving to AI chat. v2 inverts it: the structured data is the product; the site is the free distribution channel for it.

### Non-goals

- No runtime backend of any kind. No API server, no database in production, no serverless functions. The MCP server runs on the user's machine and consumes **static files downloaded from the CDN**.
- No user accounts, comments, analytics beyond free-tier basics, ads (initially).
- No per-repo subdomains or per-repo site builds.
- No Postgres, Redis, BullMQ, Docker in the new system. Local pipeline state lives in SQLite.

### Hard cost ceiling

~$10/year (one domain). Everything else must fit free tiers: Cloudflare Pages (static hosting, unlimited bandwidth), npm (MCP package), GitHub (repo + CI if wanted). LLM analysis runs through the operator's existing subscription CLI (GLM CLI or Claude CLI) — the pipeline must treat the LLM CLI as a pluggable subprocess, never a metered API SDK.

---

## 2. System Overview

Three components in one pnpm workspace:

```
err-lookup/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
├── data/
│   └── errlookup.db          # SQLite — pipeline working state (gitignored)
├── packages/
│   ├── schema/               # @errlookup/schema — shared types + JSON Schema + zod validators
│   ├── pipeline/             # @errlookup/pipeline — repo analysis CLI (LLM-driven)
│   ├── site/                 # @errlookup/site — static site generator (Astro)
│   └── mcp/                  # @errlookup/mcp — published npm package, stdio MCP server
└── docs/
    └── rebuild-spec.md       # this file
```

Data flow:

```
GitHub repo ──clone──▶ pipeline (LLM agents, 5 phases) ──▶ SQLite
SQLite ──export──▶ site build ──▶ static HTML + static JSON dataset ──▶ Cloudflare Pages
Cloudflare Pages ◀──HTTPS GET (versioned JSON files)── MCP server (local, cached)
```

The **static JSON dataset is the contract** between the site and the MCP server. It is versioned, immutable per release, and described fully in §5.

---

## 3. Data Model

### 3.1 Canonical Error record

Single source of truth: `packages/schema/src/error.ts` exporting zod schemas; JSON Schema generated from zod at build time into `packages/schema/schema.json`. All components validate against these — the pipeline on write, the site build on read, the MCP server on download. Fail fast on validation errors; never silently drop or coerce.

```ts
// zod shapes shown as TS for readability

interface ErrorEntry {
  id: string;                 // stable: sha256(repo + errorCode|normalizedMessage + filePath).slice(0, 16)
  repo: string;               // "owner/name"
  slug: string;               // URL-safe, unique within repo. From errorCode, else first 50 chars of message.
  errorCode: string | null;   // "ERR_INVALID_URL", "ECONNRESET", null if none
  errorMessage: string;       // exact string from source, template placeholders preserved: "Cannot find module '{module}'"
  messagePattern: string;     // regex derived from errorMessage with placeholders → capture groups (see §7.3)
  errorType: "exception" | "error_code" | "console" | "http" | "validation" | "panic";
  errorClass: string | null;  // e.g. "TypeError", "HTTPError"
  httpStatus: number | null;
  severity: "critical" | "error" | "warning" | "info";

  // Source location
  filePath: string;           // repo-relative
  lineNumber: number | null;
  sourceCode: string | null;  // throwing region, ≤40 lines
  sourceCodeStart: number | null;
  sourceCodeEnd: number | null;
  githubUrl: string;          // permalink pinned to analyzed SHA, not branch

  // Enrichment (LLM-generated, markdown strings)
  documentation: string;      // what the error means, why the library throws it
  triggerScenarios: string;   // concrete situations that produce it
  commonSituations: string;   // real-world contexts (config mistakes, env issues)
  solutions: string[];        // ordered, most likely fix first
  exampleFix: string | null;  // before/after code block

  // Defensive programming
  handlingStrategy: "try-catch" | "type-guard" | "validation" | "retry" | "fallback" | null;
  validationCode: string | null;
  typeGuard: string | null;
  tryCatchPattern: string | null;
  preventionTips: string[];

  tags: string[];             // lowercase kebab: "network", "typescript", "config"
  analyzedSha: string;        // git SHA of repo when analyzed
  analyzedAt: string;         // ISO 8601 UTC
  schemaVersion: 2;
}

interface RepoEntry {
  repo: string;               // "owner/name"
  description: string | null;
  language: string | null;
  stars: number;
  defaultBranch: string;
  analyzedSha: string;
  analyzedAt: string;
  errorCount: number;
}
```

### 3.2 SQLite (pipeline working state only)

Drizzle ORM with `drizzle-orm/sqlite-core` + `better-sqlite3`. Never shipped; the static export is the publication format.

Tables:

- `repositories` — RepoEntry columns + `status` (`pending | analyzing | analyzed | failed | exported`), `lastError`.
- `errors` — ErrorEntry columns; arrays and structured fields stored as JSON text columns. Unique index on `(repo, slug)`; unique index on `id`.
- `job_history` — `repo, phase, status, startedAt, completedAt, durationMs, errorLog`. Instrumentation: every phase run recorded, success or fail.

WAL mode on. All multi-row writes in transactions. Pipeline is idempotent and restartable at phase granularity (see §4.5).

### 3.3 Migration from v1

One-off script `packages/pipeline/scripts/import-v1.ts`: reads v1 Postgres (docker-compose in old repo, `postgres://errlookup:errlookup_dev@localhost:15432/errlookup`) and maps rows to the v2 schema, computing `id`, `slug`, `messagePattern`. Rows failing v2 validation are written to `import-rejects.jsonl` with the validation error — reported, not skipped silently. If v1 data proves unrecoverable, skip migration; re-analysis is cheap.

---

## 4. Pipeline (`@errlookup/pipeline`)

CLI tool, run locally by the operator. Commands:

```
errlookup analyze <owner/repo> [--phases 1,2,3,4,5] [--force]
errlookup batch <file.txt>          # one owner/repo per line, sequential
errlookup export                    # SQLite → static JSON dataset (see §5)
errlookup status                    # table of repos, phases done, error counts
```

### 4.1 LLM provider abstraction

The pipeline shells out to an agent CLI in non-interactive mode. Configuration in `errlookup.config.kdl` at repo root:

```kdl
provider "glm" {
    command "glm"
    args "-p" "--output-format" "json"
    timeout-ms 600000
}
provider "claude" {
    command "claude"
    args "-p" "--output-format" "json" "--max-turns" "30"
    timeout-ms 600000
}
defaults {
    primary "glm"
    fallback "claude"
    max-concurrent 1
    delay-between-phases-ms 5000
}
```

Contract for a provider invocation: spawn `command` with `args` + prompt on stdin (or as final arg — adapter per provider), cwd = cloned repo directory, capture stdout, parse the JSON payload out of it (strip any non-JSON preamble by locating the first `{`/`[` that parses). On parse failure or nonzero exit: retry once, then fall back to the fallback provider, then mark the phase failed. Never fabricate output.

### 4.2 Analysis phases

Clone target repo shallow (`--depth 1`) into a temp workdir; record HEAD SHA. Phases run sequentially per repo; enrichment phases batch errors 10 at a time per LLM call.

1. **Discovery** — agent scans the repo for user-facing errors (throw/raise/panic, error classes, error constants, HTTP error responses, validation errors). Skips tests, mocks, debug logs. Output: JSON array of `{message, type, file, line, code, errorClass, httpStatus}`. Port the v1 prompt from `apps/orchestrator/.claude/agents/error-discovery.md` — it works.
2. **Enrichment** — for each discovered error: documentation, triggerScenarios, commonSituations, solutions[], exampleFix, severity, tags, and extraction of the throwing source region (≤40 lines) with line span.
3. **Defense** — handlingStrategy, validationCode, typeGuard, tryCatchPattern, preventionTips[] per error, in the repo's language.
4. **Cross-linking** — related error suggestions within the repo (populates `tags` overlaps; no separate table needed — MCP and site derive "related" from shared tags + repo).
5. **Verify** — agent reviews the assembled records for gaps (empty documentation, solutions that don't parse as actionable, wrong file paths) and emits patch JSON; pipeline applies patches, re-validates, loops max twice.

Port v1 prompts from `apps/orchestrator/.claude/agents/*.md` where they exist; they are proven. Do not port the v1 "supervisor agent" (autonomous bash-wielding watchdog) — replace with a dumb watchdog: per-phase timeout from config, on timeout kill the subprocess, record failure in `job_history`, continue to next repo.

### 4.3 Message pattern derivation

For every error, derive `messagePattern` from `errorMessage`:

- Escape regex metacharacters in literal parts.
- Replace template placeholders (`${...}`, `{}`, `%s`, `%d`, `{0}`, backtick interpolations captured from source) with `(.+?)` non-greedy groups.
- Replace obviously variable literals the LLM flags (paths, ports, hostnames in example messages) with groups.
- Anchor loosely: no `^`/`$` (real-world messages carry prefixes/suffixes).

Store as string. Validate it compiles as both JS `RegExp` and RE2-safe (no backreferences, no nested quantifiers over groups — reject and fall back to escaped-literal pattern if the derived one is ReDoS-prone).

### 4.4 Instrumentation

Structured log lines (JSON) to stderr + `pipeline.log`: phase start/end, duration, token-free (we can't meter subscription CLIs — record wall time instead), errors verbatim. `errlookup status` reads `job_history`.

### 4.5 Idempotency

Each phase writes its outputs transactionally and marks `job_history`. Re-running `analyze` skips completed phases for the same `analyzedSha` unless `--force`. A killed run resumes at the first incomplete phase.

---

## 5. Static Dataset (the MCP/site contract)

`errlookup export` writes to `packages/site/public/data/`. These files deploy verbatim with the site and are the **only** interface the MCP server uses.

```
/data/manifest.json                  # dataset version, counts, file inventory
/data/index.json                     # compact search index (all errors, all repos)
/data/repos.json                     # RepoEntry[]
/data/repos/{owner}/{name}.json      # full ErrorEntry[] for one repo
/data/errors/{id}.json               # single full ErrorEntry (for direct fetch)
```

### 5.1 `manifest.json`

```json
{
  "schemaVersion": 2,
  "datasetVersion": "2026-07-14T00:00:00Z",   // export timestamp, monotonic
  "counts": { "repos": 20, "errors": 412 },
  "files": {
    "index": { "path": "/data/index.json", "bytes": 183422, "sha256": "..." },
    "repos": { "path": "/data/repos.json", "bytes": 8120, "sha256": "..." }
  }
}
```

MCP polls only this file for freshness (it's small). Everything else is fetched on demand and cache-validated by the sha256 recorded here.

### 5.2 `index.json` — search index

One compact record per error; target < 1 KB/error so 10k errors ≈ 10 MB ceiling, fine for local cache. Gzip/brotli handled by CDN.

```json
{
  "schemaVersion": 2,
  "datasetVersion": "…",
  "errors": [
    {
      "id": "a1b2c3d4e5f60718",
      "repo": "axios/axios",
      "slug": "err-bad-response",
      "code": "ERR_BAD_RESPONSE",
      "msg": "Request failed with status code {status}",
      "pattern": "Request failed with status code (.+?)",
      "type": "http",
      "class": "AxiosError",
      "tags": ["http", "network"],
      "sev": "error"
    }
  ]
}
```

### 5.3 Immutability & atomic publish

Exports are atomic: write to `data.tmp/`, validate every file against the schema, then rename over `data/`. `datasetVersion` strictly increases. Never publish a partially written dataset — Cloudflare Pages deploys are atomic per commit, which gives this for free as long as export completes before deploy.

---

## 6. Static Site (`@errlookup/site`)

**Stack:** Astro, static output only (`output: 'static'`). No client-side framework; zero JS budget except one small search island (optional, Phase 2 of buildout). Content sourced at build time by reading the exported `/data` JSON (not SQLite — site builds must work from the published dataset alone, so CI could rebuild the site without the pipeline).

**One domain**, e.g. `errlookup.dev`. Routes:

```
/                                   # home: what this is, stats, repo list, MCP install instructions
/{owner}/{repo}/                    # repo index: error table (code, message, type, severity)
/{owner}/{repo}/{slug}/             # error page (the core page type)
/api-docs/                          # documents the static dataset contract (§5) for third parties
/llms.txt                           # AEO manifest
/sitemap.xml, /robots.txt
```

### 6.1 Error page content (in order)

1. `<h1>`: error code or truncated message. `<title>`: `"{code}: {message} — {repo} | ErrLookup"`.
2. Exact error message in a `<pre>` block — this is what people paste-search.
3. What it means (documentation).
4. Source: code block + GitHub permalink (pinned to `analyzedSha`).
5. Solutions, ordered list with code blocks.
6. Defensive patterns (validation / type guard / try-catch), collapsible `<details>`.
7. Trigger scenarios & common situations.
8. Related errors (same repo, shared tags), links.
9. Footer: analyzed SHA + date, "data as JSON" link to `/data/errors/{id}.json`, edit/report link to GitHub repo issues.

### 6.2 SEO/AEO requirements

- JSON-LD on every error page: `TechArticle` + `FAQPage` (question = error message, answer = top solution).
- `llms.txt` listing dataset URLs and site purpose; every error page links its JSON twin via `<link rel="alternate" type="application/json">`.
- Canonical URLs, per-repo sitemap partitions under a sitemap index.
- Honest provenance: visible "AI-assisted analysis of `{repo}@{sha}`" line on every page. No fake authorship.
- Page weight: < 50 KB HTML per error page, no web fonts, system font stack.

### 6.3 Hosting & deploy

Cloudflare Pages, single project, production branch `main`. Build command `pnpm --filter @errlookup/site build`, output `packages/site/dist`. Custom domain + automatic HTTPS. Cache headers via `_headers` file:

```
/data/manifest.json
  Cache-Control: public, max-age=300
/data/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
```

---

## 7. MCP Server (`@errlookup/mcp`)

Published to npm as `@errlookup/mcp`. Users add:

```json
{ "mcpServers": { "errlookup": { "command": "npx", "args": ["-y", "@errlookup/mcp"] } } }
```

**Runtime model: no backend.** On startup and on a freshness check (manifest poll, ≥5 min between polls), the server downloads static JSON from `https://errlookup.dev/data/…`, caches under `~/.cache/errlookup/` (respect `XDG_CACHE_HOME`), and answers all tool calls from the local cache. Fully offline-capable after first sync: if the network is down, serve from cache and report `stale: true` + cache age in results. If no cache exists and the network is down, tools return a clear error — never empty results pretending success.

**Stack:** TypeScript, `@modelcontextprotocol/sdk`, stdio transport. Node ≥ 20, no native deps (use `fetch`; pure-JS search).

### 7.1 Cache layout

```
~/.cache/errlookup/
├── manifest.json
├── index.json
└── repos/{owner}/{name}.json        # fetched lazily on first detail request
```

Sync algorithm: fetch `manifest.json`; if `datasetVersion` unchanged, done. Else download `index.json`, verify sha256 against manifest, write via temp-file + rename (atomic, no partial reads by concurrent MCP instances). Lazily-fetched repo files are invalidated when `datasetVersion` changes.

### 7.2 Tools

```
search_error
  input:  { message: string, repo?: string, limit?: number = 5 }
  output: { matches: [{ id, repo, code, message, score, matchType, url }], datasetVersion, stale }

get_error
  input:  { id: string }        // or { repo, slug }
  output: full ErrorEntry + { url, datasetVersion }

list_repos
  input:  {}
  output: { repos: RepoEntry-compact[], datasetVersion }

refresh_dataset
  input:  {}
  output: { updated: boolean, datasetVersion, errors: count }
```

Tool descriptions must tell the calling agent when to use them: `search_error` → "Call when you encounter a runtime error message from an open-source library; pass the raw message." Output of `get_error` is markdown-formatted for direct agent consumption (documentation + solutions + defensive pattern), with the site URL for citation.

### 7.3 Matching algorithm (`search_error`)

Input message is matched in tiers; first tier with hits wins, `matchType` reports which:

1. **exact-code** — token in input matches an `errorCode` exactly (extract SCREAMING_SNAKE and `E[A-Z]+` tokens from input).
2. **pattern** — input tests against each entry's `messagePattern` regex (bounded: skip patterns > 500 chars; total regex budget 50 ms, then cut to tier 3).
3. **fuzzy** — normalized token overlap: lowercase, strip digits/paths/hex/quoted strings from both sides, score = weighted Jaccard over remaining tokens with rare-token boost (IDF computed over the index at load time). Threshold 0.4; below that return empty with a "no confident match" note.

`repo` filter, when given, restricts all tiers. Score ∈ [0,1] always populated (exact-code = 1.0, pattern = 0.9, fuzzy = its Jaccard score).

### 7.4 Config

Env vars (all optional): `ERRLOOKUP_BASE_URL` (default `https://errlookup.dev`), `ERRLOOKUP_CACHE_DIR`, `ERRLOOKUP_TTL_SECONDS` (manifest poll interval, default 300), `ERRLOOKUP_OFFLINE=1` (never fetch, cache only).

---

## 8. Quality Gates & Testing

Test hierarchy: e2e > integration > unit. No mocks for business logic; mock only the network boundary (recorded fixture JSON for MCP sync tests) and the LLM CLI (replay fixtures of real provider stdout captured during development).

Required suites:

1. **schema** — zod validators accept every fixture record; reject each mutated-invalid variant.
2. **pipeline** — provider adapter parses real captured CLI outputs (fixtures incl. preamble junk, truncated JSON → must fail loudly); pattern derivation unit tests (template literals, %s, ReDoS rejection); export produces a dataset that re-validates; interrupted export leaves previous dataset intact.
3. **site** — build succeeds from a fixture dataset; every error page contains exact message text, JSON-LD parses, no page > 50 KB; internal links resolve (crawl `dist/`).
4. **mcp** — e2e over fixture dataset served from a local static server: sync → search tiers (exact-code/pattern/fuzzy each covered) → get_error → offline mode → stale-cache behavior → corrupt-download (sha mismatch) rejected, old cache retained.

All tests pass before any commit. Atomic conventional commits per the repo's standards.

---

## 9. Milestones

Ordered; each ends with green tests + a commit. No time estimates.

1. **M1 — schema**: `@errlookup/schema` with zod + generated JSON Schema + fixtures.
2. **M2 — pipeline core**: SQLite via drizzle, provider abstraction with GLM adapter, phases 1–2 working against one small repo (`sindresorhus/is`), watchdog, idempotent resume.
3. **M3 — pipeline complete**: phases 3–5, batch command, pattern derivation, `export` with atomic publish + validation. Optional: v1 Postgres import.
4. **M4 — site**: Astro site over exported dataset, all routes, SEO/AEO items, `_headers`, deploy to Cloudflare Pages on a placeholder domain.
5. **M5 — mcp**: full server per §7, e2e suite, `npx` smoke test against the deployed dataset, publish `0.1.0` to npm.
6. **M6 — smoke corpus**: analyze the 20-repo starter list (`docs/projects-to-analyze.md` from v1) as a pipeline shakedown. Deploy, submit sitemap, publish MCP.
7. **M7 — corpus blitz**: multi-day token-maxed batch run per §11. Incremental daily exports + deploys throughout.

## 11. Corpus Blitz (multi-day token-maxed run)

Operator has approved several days of continuous LLM usage on their subscription account. The pipeline must support an unattended multi-day run.

### 11.1 Corpus selection

`errlookup corpus build` generates the queue file programmatically (GitHub API, unauthenticated rate limits are fine for metadata; use `GITHUB_TOKEN` if present):

- Top ~500 npm packages by weekly downloads (resolve to source repos), top ~300 PyPI, top ~200 crates.io, top ~200 Go modules, plus top-starred repos per language from the v1 list's categories.
- Skip: forks, archived repos, monorepos > 2 GB clone size (record as `skipped_too_large`), docs/awesome-list repos (no error surface), repos already `analyzed` at current HEAD SHA.
- Priority order within queue: weekly downloads desc — usage correlates with error-search volume and MCP hit rate.
- Queue is a SQLite table (`queue`), not a text file: `repo, priority, status, attempts, lastError`. `errlookup batch --from-queue` claims rows one at a time.

### 11.2 Throughput & concurrency

v1 measured ~6–8 min/repo single-stream. Config `max-concurrent` raises parallel repo analyses (each is an independent subprocess chain + its own clone dir). Start at 3; back off to 1 automatically if the provider CLI starts returning rate-limit/overload errors (detect via nonzero exits with rate-limit text; exponential backoff, resume after cool-down). Realistic yield: ~200–400 repos/day at concurrency 2–3 → a few days covers ~1,000+ repos / ~20–40k errors.

### 11.3 Unattended-run requirements

- **Resumable**: already required (§4.5); a killed multi-day run resumes with `errlookup batch --from-queue` and loses at most one in-flight repo phase.
- **Watchdog**: per-phase timeout kills hung subprocesses (v1's zod hang is the known failure mode); repo marked `failed` after 2 attempts, run continues. No LLM supervisor.
- **Daily publish**: a scheduled step (cron or loop wrapper) runs `errlookup export && deploy` every ~6h so progress ships continuously; atomic export guarantees never publishing a torn dataset.
- **Quality sampling gate**: after every 50 analyzed repos, pipeline samples 5 random new errors and runs a cheap validation pass (schema-complete, solutions non-empty, sourceCode present, GitHub permalink resolves with HTTP 200). If >20% of sample fails, pause the queue and flag for operator review — protects against a degraded provider silently filling the DB with junk for days.
- **Disk hygiene**: delete clone dirs after each repo; cap cache/workdir at a configured budget.

### 11.4 Index scaling

§5.2's single `index.json` holds to ~40k errors (~40 MB raw, ~5–8 MB brotli over the wire, one-time download per dataset version). If the index exceeds **30 MB raw**, export shards it: `index-manifest.json` + `index-{a..z,0-9}.json` sharded by repo first letter; MCP downloads shards lazily but always fetches all shards on first sync (search is global). Site sitemaps partition per-repo regardless of size (§6.2).

### 11.5 Post-blitz validation (unchanged in spirit)

After the blitz: submit updated sitemaps, then stop generating and watch Search Console impressions + npm downloads + any MCP telemetry-free proxy (GitHub stars, registry installs) for ≥4 weeks before further corpus expansion.

## 10. Explicitly Deleted from v1

- Postgres, Redis, BullMQ, docker-compose, queue/ worker code.
- Per-repo Docusaurus projects (`sites/`, `packages/repo-template/`, `packages/resources-hub/`).
- Cloudflare per-repo project provisioning (`cloudflareProjectId`, `subdomain` columns).
- Supervisor LLM agent with bash access (replaced by dumb timeout watchdog).
- `resources` / `error_resources` tables and the article-recommendation phase output as separate entities — folded into tags/related-by-tags. (Keep the recommendation prompt output as `preventionTips` enrichment only if trivially available; otherwise drop.)
