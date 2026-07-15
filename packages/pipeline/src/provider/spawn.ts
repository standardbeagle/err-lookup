import { spawn, type ChildProcess } from "node:child_process";
import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";
import { extractJson } from "./json.js";
import type { ProviderConfig } from "../config/index.js";

interface RunHandle {
  child: ChildProcess;
  kill: () => void;
}

function spawnGroup(cmd: string, args: string[], cwd: string): RunHandle {
  // detached:true makes child.pid the process-group leader; kill(-pid) reaps the tree.
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  return { child, kill };
}

/** A provider that shells out to an agent CLI (claude, glm, ...) per §4.1. */
export class SpawningProvider implements LlmProvider {
  constructor(readonly name: string, private readonly cfg: ProviderConfig) {}

  async invoke(prompt: string, opts: InvokeOptions): Promise<ProviderResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const args =
      this.cfg.promptMode === "arg" ? [...this.cfg.args, prompt] : this.cfg.args;
    const cwd = opts.cwd;

    let handle: RunHandle;
    try {
      handle = spawnGroup(this.cfg.command, args, cwd);
    } catch (e) {
      return { ok: false, kind: "spawn", error: `failed to spawn ${this.cfg.command}: ${(e as Error).message}` };
    }
    const { child, kill } = handle;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    if (this.cfg.promptMode === "stdin") {
      child.stdin?.end(prompt);
    } else {
      child.stdin?.end();
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const code: number | null = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
      child.once("error", (err) => {
        if (timedOut) return;
        stderr += `\nspawn error: ${err.message}`;
        // resolve with nonzero so the result reflects failure
        resolve(-1);
      });
    });

    clearTimeout(timer);

    if (timedOut) {
      return {
        ok: false,
        kind: "timeout",
        error: `${this.name} exceeded ${timeoutMs}ms (killed process group)`,
      };
    }
    if (code !== 0) {
      return {
        ok: false,
        kind: "spawn",
        error: `${this.name} exited ${code}: ${stderr.slice(0, 500)}`,
      };
    }

    const extracted = extractJson(stdout);
    return extracted;
  }
}
