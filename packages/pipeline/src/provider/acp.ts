import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { extractJson } from "./json.js";
import type { ProviderConfig } from "../config/index.js";

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Provider speaking ACP (Agent Client Protocol, JSON-RPC over stdio) to an agent
 * CLI such as `opencode acp`. One process + one session per invocation: the
 * session cwd is the cloned repo, the model is pinned via OPENCODE_CONFIG_CONTENT,
 * and tool permission requests are auto-allowed (the agent must read the repo and
 * write the output file). The agent's text chunks are collected as `raw`.
 */
/**
 * Tools the agent may use, and nothing else. opencode puts its whole toolset's
 * schemas in the system prompt of every request, and that is most of what a
 * call costs before our prompt is read at all: measured against
 * kimi-for-coding/k3, a five-word prompt costs 13.1k context tokens with the
 * default toolset and 8.9k with just these two — 4.2k saved on every call of
 * every phase, for tools no phase uses.
 *
 * The two that stay are load-bearing: `write` delivers the JSON to the output
 * file (see provider/run.ts), and `read` is the fallback the discovery and
 * analysis prompts offer when an embedded source region is not enough.
 */
/**
 * NO `edit` or `patch` keys, deliberately: opencode collapses write/edit/patch
 * into ONE "edit" permission class, iterating the tools map in insertion order
 * with last-entry-wins (config.ts: `if (tool === "write" || "edit" || "patch")
 * perms.edit = action`). The old map's `patch: false` came after `write: true`
 * and flipped the class to deny — the write tool vanished and every phase
 * failed with "agent did not write <file>" (the 2026-08-26 isolation
 * incident). `write: true` must be the only edit-class entry; the edit tool
 * riding along enabled is harmless in a scratch clone.
 */
const PIPELINE_TOOLS = {
  bash: false,
  write: true,
  read: true,
  grep: false,
  glob: false,
  list: false,
  todowrite: false,
  todoread: false,
  webfetch: false,
  task: false,
} as const;

/**
 * Tool policy actually sent, with an override hook for measurement:
 * ERRLOOKUP_ACP_TOOLS='{"read":false}' merges over the defaults. Step count is
 * what a policy really controls — a call that reads three files pays for the
 * whole context four times — so being able to A/B a policy without editing
 * code is worth the four lines.
 */
function toolPolicy(): Record<string, boolean> {
  // Named denies only — NO "*" wildcard. Probed against opencode 2026-08-26:
  // {"*":false, ..., write:true} leaves the agent with read+lci but WITHOUT
  // write (the exact key did not win over the glob), which silently breaks
  // the output-file handoff of every phase. Unknown-tool exposure is instead
  // closed by the XDG isolation: with no user config there is no MCP registry
  // to inherit tools from, and lci's tools (lci_*) are wanted.
  const base: Record<string, boolean> = { ...PIPELINE_TOOLS };
  const raw = process.env.ERRLOOKUP_ACP_TOOLS;
  if (!raw) return base;
  try {
    return { ...base, ...(JSON.parse(raw) as Record<string, boolean>) };
  } catch {
    return base;
  }
}

/**
 * Extraction calls run against a config vacuum, not the developer's setup.
 * The user-level opencode.json (slop-mcp → worktrack and every other system
 * MCP), global skills, plugins, and instructions all merge UNDER
 * OPENCODE_CONFIG_CONTENT — pointing XDG_CONFIG_HOME at an empty directory
 * makes the content the whole configuration. lci is re-added explicitly as
 * the one MCP the extraction flow wants.
 *
 * This is the only path — the legacy developer-config merge is gone. The
 * 2026-08-26 "isolation strips write" incident was never isolation's fault
 * (the PIPELINE_TOOLS map's patch:false flipped opencode's collapsed
 * edit-permission class — see the note on PIPELINE_TOOLS), and the 2026-08-27
 * three-repo comparison exonerated it: the un-isolated control did worse on
 * the same inputs (docs/isolation-comparison-2026-08-27.md).
 */
let isolatedHome: string | null = null;
function isolatedConfigHome(): string {
  if (!isolatedHome) {
    isolatedHome = join(tmpdir(), `errlookup-acp-config-${process.pid}`);
    mkdirSync(join(isolatedHome, "opencode"), { recursive: true });
  }
  return isolatedHome;
}

export class AcpProvider implements LlmProvider {
  constructor(readonly name: string, private readonly cfg: ProviderConfig) {}

  async invoke(prompt: string, opts: InvokeOptions): Promise<ProviderResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Empty config home: the user's opencode.json (and its MCP registry),
    // global skills, and instructions never reach the extraction agent.
    // Auth is untouched — it lives under XDG_DATA_HOME.
    env.XDG_CONFIG_HOME = isolatedConfigHome();
    // model is "providerId/modelId"; modelOptions pin per-model settings
    // (reasoning effort, thinking toggles) the same way the user's static
    // opencode.json pins them — OPENCODE_CONFIG_CONTENT merges over it.
    // First "/" splits provider from model; the model id itself may contain "/".
    const slash = this.cfg.model?.indexOf("/") ?? -1;
    const providerId = slash > 0 ? this.cfg.model!.slice(0, slash) : "";
    const modelId = slash > 0 ? this.cfg.model!.slice(slash + 1) : "";
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
      ...(providerId && modelId && this.cfg.modelOptions
        ? { provider: { [providerId]: { models: { [modelId]: { options: this.cfg.modelOptions } } } } }
        : {}),
      // The one MCP the extraction flow keeps: lci code search over the clone.
      mcp: { lci: { type: "local", command: ["lci", "mcp"], enabled: true } },
      agent: { build: { tools: toolPolicy() } },
    });

    let child: ChildProcess;
    try {
      child = spawn(this.cfg.command, this.cfg.args, {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return { ok: false, kind: "spawn", error: `failed to spawn ${this.cfg.command}: ${(e as Error).message}` };
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };

    let stderrTail = "";
    child.stderr?.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-500);
    });

    let nextId = 0;
    const pending = new Map<number | string, PendingRequest>();
    const send = (msg: object) => {
      child.stdin?.write(JSON.stringify(msg) + "\n");
    };
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });

    // Idle watchdog: a working agent streams session/update events (text
    // chunks, thoughts, tool calls) continuously, so protocol silence is the
    // stall signal. The wall-clock timer below stays as the hard ceiling, but
    // sized for a stall it killed genuinely active calls — tensorflow-scale
    // verify batches died at 600s mid-stream, their records going unpatched.
    const idleMs = this.cfg.idleTimeoutMs;
    let killReason: string | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (reason: string) => {
      killReason = reason;
      const err = new Error(reason);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      kill();
    };
    const armIdle = () => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort(`no ACP activity for ${idleMs}ms`), idleMs);
    };

    let agentText = "";
    let buffer = "";
    child.stdout?.on("data", (d) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue; // non-protocol noise on stdout
        }
        armIdle(); // any protocol message proves the agent is alive
        if (msg.id != null && msg.method === undefined) {
          // response to one of our requests
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
        } else if (msg.method === "session/update") {
          const u = (msg.params?.update ?? {}) as {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
          };
          if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
            agentText += u.content.text ?? "";
          }
        } else if (msg.method === "session/request_permission" && msg.id != null) {
          // Unattended run: allow tool use (read repo, write output file).
          const options = (msg.params?.options ?? []) as { optionId?: string; kind?: string }[];
          const allow = options.find((o) => o.kind?.startsWith("allow")) ?? options[0];
          send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
        } else if (msg.id != null) {
          // Unknown agent→client request; answer neutrally so the session proceeds.
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      }
    });

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    const timer = setTimeout(() => abort(`exceeded ${timeoutMs}ms hard ceiling`), timeoutMs);
    armIdle();

    try {
      await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const sess = (await request("session/new", { cwd: opts.cwd, mcpServers: [] })) as { sessionId?: string };
      if (!sess?.sessionId) throw new Error("session/new returned no sessionId");
      await request("session/prompt", {
        sessionId: sess.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
    } catch (e) {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      kill();
      await exited;
      if (killReason) {
        return { ok: false, kind: "timeout", error: `${this.name} ${killReason} (killed ACP process group)` };
      }
      return { ok: false, kind: "spawn", error: `${this.name} ACP failure: ${(e as Error).message}; stderr: ${stderrTail}` };
    }

    clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    kill();
    await exited;

    if (opts.outputFile) {
      if (!existsSync(opts.outputFile)) {
        return {
          ok: false,
          kind: "empty",
          error: `${this.name}: agent did not write ${opts.outputFile}; last text: ${agentText.slice(-200)}`,
        };
      }
      return extractJson(readFileSync(opts.outputFile, "utf8"));
    }
    return extractJson(agentText);
  }
}
