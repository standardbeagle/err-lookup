# @standardbeagle/errlookup-mcp

MCP server that answers **"what is this error and how do I fix it"** for open-source libraries, from a locally cached static dataset published at [errors.standardbeagle.com](https://errors.standardbeagle.com).

No backend: on first use it downloads versioned JSON from the CDN, caches under `~/.cache/errlookup/`, and serves every query offline-capable from disk.

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

- `search_error` — pass a raw runtime error message; tiered matching (exact code → message pattern → fuzzy) returns scored matches with citations.
- `get_error` — full record for one error: explanation, ordered solutions, example fix, defensive patterns, source permalink.
- `list_repos` — analyzed repositories and their error counts.
- `refresh_dataset` — force a freshness check against the published manifest.

## Config (env)

| var | default | |
|---|---|---|
| `ERRLOOKUP_BASE_URL` | `https://errors.standardbeagle.com` | dataset origin |
| `ERRLOOKUP_CACHE_DIR` | `$XDG_CACHE_HOME/errlookup` | cache location |
| `ERRLOOKUP_TTL_SECONDS` | `300` | manifest poll interval |
| `ERRLOOKUP_OFFLINE` | unset | `1` = never fetch, cache only |

Data is AI-assisted analysis of public repositories, pinned to the analyzed commit SHA — every result links its source and its JSON twin.
