import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const PIPELINE_TOOLS = {
  bash: false,
  edit: false,
  write: true,
  read: true,
  grep: false,
  glob: false,
  list: false,
  patch: false,
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
  const base: Record<string, boolean> = { ...PIPELINE_TOOLS };
  const raw = process.env.ERRLOOKUP_ACP_TOOLS;
  if (!raw) return base;
  try {
    return { ...base, ...(JSON.parse(raw) as Record<string, boolean>) };
  } catch {
    return base;
  }
}

export class AcpProvider implements LlmProvider {
  constructor(readonly name: string, private readonly cfg: ProviderConfig) {}

  async invoke(prompt: string, opts: InvokeOptions): Promise<ProviderResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
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

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const err = new Error(`ACP call exceeded ${timeoutMs}ms`);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      kill();
    }, timeoutMs);

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
      kill();
      await exited;
      if (timedOut) {
        return { ok: false, kind: "timeout", error: `${this.name} exceeded ${timeoutMs}ms (killed ACP process group)` };
      }
      return { ok: false, kind: "spawn", error: `${this.name} ACP failure: ${(e as Error).message}; stderr: ${stderrTail}` };
    }

    clearTimeout(timer);
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
