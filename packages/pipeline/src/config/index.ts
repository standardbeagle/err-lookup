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
    /** Repos analyzed concurrently in a `batch` run. */
    maxConcurrent: number;
    /** LLM calls in flight within one phase of one repo. */
    batchConcurrency: number;
    /**
     * Hard ceiling on concurrent provider calls process-wide, matching the
     * account's rate limit. 0 disables the gate. Set this and the two knobs
     * above may over-subscribe safely.
     */
    providerMaxConcurrent: number;
    /** Errors per enrichment/defense call. */
    analysisBatchSize: number;
    /** Lines of source either side of an error in the analysis prompt. */
    sourceWindow: number;
    /**
     * Minutes a drain claims new repos for before it stops and exits, so the
     * supervisor can start one on freshly deployed code. In-flight repos
     * still finish. 0 = run until the queue empties, however long that takes.
     */
    maxRuntimeMinutes: number;
    /**
     * Attach the enclosing function and its callers, read from lci's symbol
     * index, to each error in the analysis prompt. Costs no provider tokens to
     * produce; costs roughly a fifth of a source window to send.
     */
    callFacts: boolean;
    /** Pause between repos during the provider's peak-price window. */
    skipPeak: boolean;
    delayBetweenPhasesMs: number;
    /**
     * Share of analysis starts the drain gives to rescans of already-published
     * repos while never-analyzed repos are still queued (0 = import first,
     * 1 = rescans first). Balances growing the index against keeping it fresh.
     */
    rescanShare: number;
  };
  /**
   * Per-phase provider overrides (model routing): cheap models for bulk
   * phases, a stronger model for verify. Falls back to defaults.primary.
   */
  phaseProviders?: Partial<Record<"scope" | "discovery" | "enrichment" | "defense" | "verify" | "review", string>>;
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
    batchConcurrency: 1,
    providerMaxConcurrent: 0,
    analysisBatchSize: 20,
    sourceWindow: 12,
    maxRuntimeMinutes: 240,
    callFacts: false,
    skipPeak: false,
    delayBetweenPhasesMs: 5_000,
    rescanShare: 0.25,
  },
};

/** Clamp a concurrency knob to a sane positive integer. */
function asConcurrency(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return n >= 1 ? n : fallback;
}

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
    } else if (node.name === "phase-providers") {
      cfg.phaseProviders = {};
      for (const phase of ["scope", "discovery", "enrichment", "defense", "verify", "review"] as const) {
        const v = childByName(node, phase)?.values[0];
        if (typeof v === "string" && v) cfg.phaseProviders[phase] = v;
      }
    } else if (node.name === "defaults") {
      cfg.defaults = {
        primary: asString(childByName(node, "primary")?.values[0], cfg.defaults.primary),
        fallback:
          childByName(node, "fallback")?.values[0] != null
            ? asString(childByName(node, "fallback")?.values[0], "")
            : undefined,
        maxConcurrent: asConcurrency(childByName(node, "max-concurrent")?.values[0], 1),
        batchConcurrency: asConcurrency(childByName(node, "batch-concurrency")?.values[0], 1),
        // 0 is meaningful here (no gate), so it bypasses the positive-clamp.
        providerMaxConcurrent: Math.max(0, Math.floor(asNumber(childByName(node, "provider-max-concurrent")?.values[0], 0))),
        analysisBatchSize: asConcurrency(childByName(node, "analysis-batch-size")?.values[0], 20),
        sourceWindow: asConcurrency(childByName(node, "source-window")?.values[0], 12),
        maxRuntimeMinutes: asNumber(childByName(node, "max-runtime-minutes")?.values[0], 240),
        callFacts: childByName(node, "call-facts")?.values[0] === true,
        skipPeak: childByName(node, "skip-peak")?.values[0] === true,
        delayBetweenPhasesMs: asNumber(childByName(node, "delay-between-phases-ms")?.values[0], 5_000),
        rescanShare: Math.min(1, Math.max(0, asNumber(childByName(node, "rescan-share")?.values[0], 0.25))),
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
  // An explicitly requested config (argument or env) must exist — silently
  // falling back to defaults would run the wrong provider on real budgets.
  const explicit = configPath ?? process.env.ERRLOOKUP_CONFIG;
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new Error(`config not found: ${p} (from ${configPath ? "argument" : "ERRLOOKUP_CONFIG"})`);
    const src = readFileSync(p, "utf8");
    return p.endsWith(".json") ? mergeWithDefaults(JSON.parse(src)) : mapConfig(parseKdl(src));
  }

  const candidates = [
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
