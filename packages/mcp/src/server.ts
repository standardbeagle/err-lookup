import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CacheStore, defaultCacheConfig } from "./cache.js";
import {
  toolSearchError,
  toolGetError,
  toolListRepos,
  toolRefreshDataset,
  type ToolContext,
} from "./tools.js";

const TOOLS = [
  {
    name: "search_error",
    description:
      "Look up what a runtime error from an open-source library means and how to fix it. " +
      "Call this when you encounter an error message from a library. Pass the raw message verbatim; " +
      "error codes (SCREAMING_SNAKE / E[A-Z]+) are matched exactly first.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The raw error message verbatim." },
        repo: { type: "string", description: "Optional 'owner/name' filter." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["message"],
    },
  },
  {
    name: "get_error",
    description:
      "Fetch the full record for one error by id, or by repo+slug. Returns markdown documentation, " +
      "solutions, and a defensive pattern ready to apply. Cite the returned URL.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        repo: { type: "string" },
        slug: { type: "string" },
      },
    },
  },
  {
    name: "list_repos",
    description: "List the open-source repos covered by the ErrLookup dataset.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "refresh_dataset",
    description:
      "Force a freshness check against the ErrLookup CDN. Returns the current dataset version. " +
      "Pass full=true to also download the whole dataset for offline use.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "Download every shard so later lookups work offline." },
      },
    },
  },
];

export function createContext(): ToolContext {
  const cfg = defaultCacheConfig();
  const store = new CacheStore(cfg);
  return { store, ttlSeconds: cfg.ttlSeconds };
}

export async function runServer(ctx: ToolContext = createContext()): Promise<void> {
  const server = new Server(
    { name: "errlookup", version: "0.1.3" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      switch (name) {
        case "search_error": {
          const r = await toolSearchError(ctx, (args ?? {}) as never);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_error": {
          const r = await toolGetError(ctx, (args ?? {}) as never);
          return { content: [{ type: "text", text: r.markdown }, { type: "text", text: `Source: ${r.url}` }] };
        }
        case "list_repos": {
          const r = await toolListRepos(ctx);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "refresh_dataset": {
          const r = await toolRefreshDataset(ctx, (args ?? {}) as { full?: boolean });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        default:
          return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
