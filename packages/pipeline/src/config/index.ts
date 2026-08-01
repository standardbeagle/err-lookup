import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseKdl, type KdlDocument, type KdlNode } from "./kdl.js";

export interface ProviderConfig {
  command: string;
  args: string[];
  timeoutMs: number;
  /** How the prompt is delivered: piped to stdin (default) or appended as a final arg. */
  promptMode: "stdin" | "arg";
  /** Invocation protocol: plain subprocess (default) or ACP (JSON-RPC over stdio, e.g. `opencode acp`). */
  type: "spawn" | "acp";
  /** Model override for ACP providers (opencode `provider/model` id), pinned via OPENCODE_CONFIG_CONTENT. */
  model: string | null;
}

export interface ErrlookupConfig {
  providers: Record<string, ProviderConfig>;
  defaults: {
    primary: string;
    fallback: string | undefined;
    maxConcurrent: number;
    delayBetweenPhasesMs: number;
  };
}

export const DEFAULT_CONFIG: ErrlookupConfig = {
  providers: {
    claude: {
      command: "claude",
      args: ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"],
      timeoutMs: 600_000,
      promptMode: "stdin",
      type: "spawn",
      model: null,
    },
  },
  defaults: {
    primary: "claude",
    fallback: undefined,
    maxConcurrent: 1,
    delayBetweenPhasesMs: 5_000,
  },
};

function childByName(node: KdlNode, name: string): KdlNode | undefined {
  return node.children.find((c) => c.name === name);
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Map a parsed KDL document into the typed ErrlookupConfig. */
export function mapConfig(doc: KdlDocument): ErrlookupConfig {
  const cfg: ErrlookupConfig = structuredClone(DEFAULT_CONFIG);
  cfg.providers = {};

  for (const node of doc.nodes) {
    if (node.name === "provider") {
      const providerName = asString(node.values[0], "");
      if (!providerName) continue;
      cfg.providers[providerName] = {
        command: asString(childByName(node, "command")?.values[0], providerName),
        args: (childByName(node, "args")?.values ?? []).map((v) => asString(v, "")),
        timeoutMs: asNumber(childByName(node, "timeout-ms")?.values[0], 600_000),
        promptMode:
          asString(childByName(node, "prompt-mode")?.values[0], "stdin") === "arg"
            ? "arg"
            : "stdin",
        type: asString(childByName(node, "type")?.values[0], "spawn") === "acp" ? "acp" : "spawn",
        model: childByName(node, "model")?.values[0] != null
          ? asString(childByName(node, "model")?.values[0], "")
          : null,
      };
    } else if (node.name === "defaults") {
      cfg.defaults = {
        primary: asString(childByName(node, "primary")?.values[0], cfg.defaults.primary),
        fallback:
          childByName(node, "fallback")?.values[0] != null
            ? asString(childByName(node, "fallback")?.values[0], "")
            : undefined,
        maxConcurrent: asNumber(childByName(node, "max-concurrent")?.values[0], 1),
        delayBetweenPhasesMs: asNumber(childByName(node, "delay-between-phases-ms")?.values[0], 5_000),
      };
    }
  }

  if (Object.keys(cfg.providers).length === 0) cfg.providers = structuredClone(DEFAULT_CONFIG.providers);
  return cfg;
}

/**
 * Load errlookup.config.kdl (or .json) from `cwd` (or explicit path).
 * Returns DEFAULT_CONFIG if no file is present.
 */
export function loadConfig(configPath?: string): ErrlookupConfig {
  const candidates = configPath
    ? [configPath]
    : [
        ...(process.env.ERRLOOKUP_CONFIG ? [resolve(process.env.ERRLOOKUP_CONFIG)] : []),
        resolve(process.cwd(), "errlookup.config.kdl"),
        resolve(process.cwd(), "errlookup.config.json"),
        resolve(process.cwd(), "packages", "pipeline", "errlookup.config.kdl"),
      ];

  const path = candidates.find((p) => existsSync(p));
  if (!path) return structuredClone(DEFAULT_CONFIG);

  const src = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    return mergeWithDefaults(JSON.parse(src));
  }
  return mapConfig(parseKdl(src));
}

function mergeWithDefaults(partial: Record<string, unknown>): ErrlookupConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (partial.providers && typeof partial.providers === "object") {
    cfg.providers = partial.providers as Record<string, ProviderConfig>;
  }
  if (partial.defaults && typeof partial.defaults === "object") {
    cfg.defaults = { ...cfg.defaults, ...(partial.defaults as Partial<ErrlookupConfig["defaults"]>) };
  }
  return cfg;
}
