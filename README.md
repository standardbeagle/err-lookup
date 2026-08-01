# ErrLookup

**Know what every error means — and how to fix it.**

ErrLookup reads the source of popular open-source libraries and documents every user-facing error they can raise: the exact message, what triggers it, ordered fixes, and defensive patterns — pinned to the commit that was analyzed.

**Live:** [errors.standardbeagle.com](https://errors.standardbeagle.com) · [Demo video](https://errors.standardbeagle.com/#install) · [Blog: how it works](https://errors.standardbeagle.com/blog/how-the-scanner-works/)

## For coding agents (MCP)

```json
{
  "mcpServers": {
    "errlookup": { "command": "npx", "args": ["-y", "@standardbeagle/errlookup-mcp"] }
  }
}
```

The [MCP server](https://www.npmjs.com/package/@standardbeagle/errlookup-mcp) downloads the versioned static dataset once, caches it locally, and answers `search_error` / `get_error` from disk — offline-capable, no API keys.

## For everything else

- **REST**: `GET https://errors.standardbeagle.com/api/search?q=<raw error message>` — tiered matching (exact code → derived pattern → fuzzy), scored results with citations.
- **Static dataset**: CORS-enabled versioned JSON at [`/data/manifest.json`](https://errors.standardbeagle.com/data/manifest.json) — the entire contract, no server required. See [API docs](https://errors.standardbeagle.com/api-docs/).
- **Humans**: one page per error with the exact message text, source permalink, and fixes.

## Why source-derived beats forum search

Forum answers are point-in-time guesses about somebody else's version. Every ErrLookup record is mechanically tied to a file, line, and commit SHA — regenerated when the code changes, honestly labeled as AI-assisted analysis, with the exact source line one click away. This matters most for **compiled languages**: when a Go binary or a JAR throws in production, the error string in your logs is the only artifact you have — [the source never shipped](https://errors.standardbeagle.com/blog/compiled-languages-error-lookup/).

## How it works

```
repo @ SHA ──lci/regex extraction (0 tokens)──▶ candidate sites
   ──batched LLM classify/enrich/defend──▶ validated records
   ──independent verify pass──▶ patched records
   ──atomic export──▶ versioned static JSON ──▶ CDN ──▶ site / MCP / API
```

- **Deterministic first**: a structural grep (via [lci](https://github.com/standardbeagle/lci) or a built-in walker) finds error-raising sites across nine language families before any model runs. Models judge concrete sites; they don't wander repos.
- **Model-agnostic**: providers are pluggable subprocesses (CLI print mode or [ACP](https://agentclientprotocol.com)); each phase routes independently — cheap models do bulk work, a stronger one verifies. [Benchmark results](docs/model-comparison-2026-07-31.md).
- **Crash-safe**: phases checkpoint per repo+SHA with persisted outputs; exports are atomic; a torn dataset is impossible.

## Self-hosting for internal repos

The pipeline is a local CLI and the dataset is static files — analyze private code on your own hardware and serve it from any internal host. Walkthrough: [Run ErrLookup on your own repositories](https://errors.standardbeagle.com/blog/analyze-your-internal-repos/).

## Workspace

| package | what |
|---|---|
| `packages/schema` | zod schemas + generated JSON Schema — the single source of truth |
| `packages/pipeline` | analysis CLI: extraction, LLM phases, SQLite state, atomic export |
| `packages/site` | Astro static site + Pages Functions API |
| `packages/mcp` | `@standardbeagle/errlookup-mcp` — stdio MCP server |

```sh
pnpm install
pnpm test                                  # all suites
pnpm --filter @errlookup/pipeline dev analyze sindresorhus/is
pnpm --filter @errlookup/pipeline dev export
```

## Requesting a library

[Request a crawl](https://errors.standardbeagle.com/request-crawl/) or open an issue with the `crawl-request` label.

---

Built by [Standard Beagle Studio](https://standardbeagle.com) — the AI UX agency for bold product teams. MIT licensed.
