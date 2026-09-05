# @standardbeagle/errlookup-mcp

MCP server that answers **"what is this error and how do I fix it"** for open-source libraries, from a locally cached static dataset published at [errors.standardbeagle.com](https://errors.standardbeagle.com).

No backend and no API key. The server fetches only the slice of the published index a query touches, caches it under `~/.cache/errlookup/`, and answers from disk from then on.

## Install

```json
{
  "mcpServers": {
    "errlookup": {
      "command": "npx",
      "args": ["-y", "@standardbeagle/errlookup-mcp"]
    }
  }
}
```

## Tools

- `search_error` — pass a raw runtime error message; exact error-code matches rank first, then cosine scoring over the same normalized tokens the site uses. Returns scored matches with citations.
- `get_error` — full record for one error: explanation, ordered solutions, example fix, defensive patterns, source permalink.
- `list_repos` — analyzed repositories and their error counts.
- `refresh_dataset` — force a freshness check against the published manifest. Pass `full: true` to download the entire dataset for offline use.

## How the cache stays correct

Every dataset file is stored under `v/<datasetVersion>/`, and `current.json` names the live version. A version goes live only after its manifest is on disk, so a manifest and a shard can never come from different publishes. A freshness check is one conditional `GET /data/manifest.json`; an unchanged dataset costs a 304.

Within `ERRLOOKUP_TTL_SECONDS` a query makes no network call at all. Past it the refresh runs in the background and the query answers from the version already cached. Once the cache is 12 poll intervals old, the next query waits for the refresh rather than answering from a cache that may never be revalidated — a client that starts a fresh process per call still converges on new content.

Files the manifest carries a sha256 for are verified before they are stored, and a mismatch leaves the previous cache in place.

## Offline

`ERRLOOKUP_OFFLINE=1` makes the server serve strictly from cache and never open a socket. Because fetching is lazy, offline answers cover what has been queried before; run `refresh_dataset` with `full: true` once while online to put the whole dataset on disk first.

## Config (env)

| var | default | |
|---|---|---|
| `ERRLOOKUP_BASE_URL` | `https://errors.standardbeagle.com` | dataset origin |
| `ERRLOOKUP_CACHE_DIR` | `$XDG_CACHE_HOME/errlookup` | cache location |
| `ERRLOOKUP_TTL_SECONDS` | `300` | manifest poll interval |
| `ERRLOOKUP_OFFLINE` | unset | `1` = never fetch, cache only |

## Measuring

`pnpm exec tsx scripts/bench.ts [baseUrl]` reports what one cold answer costs over the network and what a warm one costs, using a fresh cache directory per run.

Data is AI-assisted analysis of public repositories, pinned to the analyzed commit SHA — every result links its source and its JSON twin.
