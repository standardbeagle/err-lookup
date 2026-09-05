# Publishing the ErrLookup MCP server to the registries

Server name: `io.github.standardbeagle/errlookup` (GitHub-namespace authentication).
npm package: `@standardbeagle/errlookup-mcp`.

The registry name is permanent in practice — changing it later orphans every
client config that already points at it. It matches the GitHub org because
publishing under `io.github.<org>/*` only requires org **Owner** rights, while
`com.standardbeagle/*` would need an apex TXT record on `standardbeagle.com`,
whose DNS lives at Nexcess.

## Prerequisites, once

- npm publish rights on the `@standardbeagle` scope. There is no npm token in
  `devkey`, so `npm publish` runs interactively as you.
- Owner (not member) of the `standardbeagle` GitHub org, for the org namespace.

## Step 1 — publish 0.1.3 to npm

The registry validates ownership by reading `mcpName` out of the *published*
package. Version 0.1.2 on npm predates that field, so the registry rejects it;
0.1.3 carries it.

```bash
pnpm --filter @standardbeagle/errlookup-mcp test
pnpm --filter @standardbeagle/errlookup-mcp build
cd packages/mcp && npm publish --access public
```

## Step 2 — install the publisher CLI

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

## Step 3 — publish the metadata

`packages/mcp/server.json` is written and validates against the
2025-12-11 schema. Run from that directory:

```bash
cd packages/mcp
mcp-publisher validate
mcp-publisher login github   # device flow — prints a code for github.com/login/device
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.standardbeagle/errlookup"
```

`mcp-publisher login github` needs a terminal. An agent cannot complete the
device flow for you.

## Step 4 — every later release

Bump three values together or the publish fails:
`package.json` `version`, `server.json` `version`, and
`server.json` `packages[0].version`. Publish to npm first, then the registry.

## Community directories

The official registry feeds most of them, so publish there first.

| Directory | How | State |
| --- | --- | --- |
| PulseMCP | — | Submissions paused; the site points maintainers at the official registry instead. |
| Glama | "Add Server" on <https://glama.ai/mcp/servers>, then claim the listing with the GitHub account that owns the repo. Glama also auto-indexes public GitHub MCP servers. | Manual, your account |
| mcp.so | Submit button on <https://mcp.so>, or open a GitHub issue on their repo. Takes the repo URL. | Manual, your account |
| Smithery | Connect GitHub at <https://smithery.ai>, then claim the server. A *hosted* Smithery deployment additionally needs a `smithery.yaml` and an exported `createServer` — a code change we have not made, and not required for a listing. | Manual, your account |
| awesome-mcp-servers | PR against `punkpeye/awesome-mcp-servers`. | PR |

### awesome-mcp-servers entry

Place under the developer-tools section, alphabetical by owner:

```markdown
- [standardbeagle/errlookup](https://github.com/standardbeagle/err-lookup) 📇 🏠 - Explains runtime error messages from open-source libraries with cited, ordered fixes, served offline from a cached dataset.
```

Check the legend in that README before opening the PR; the emoji keys change.

### Listing copy, reused across directories

Short (under 100 characters, matches `server.json`):

> Explains open-source library error messages and gives cited, ordered fixes, offline from cache.

Long:

> ErrLookup answers "what is this error and how do I fix it" for open-source
> libraries. The dataset is extracted from pinned library commits, so every
> answer cites the source file and line that raised the message, along with
> ordered fixes and defensive patterns. The server downloads a versioned
> dataset once and then serves queries from local cache, so lookups keep
> working offline and no query text leaves the machine.
>
> Tools: `search_error`, `get_error`, `list_repos`, `refresh_dataset`.
