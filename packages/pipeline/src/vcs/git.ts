import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopLciServer } from "../util/lci-server.js";

const exec = promisify(execFile);

/**
 * Shallow-clone `owner/name` from GitHub into `dest` (§4.2 — `git clone --depth 1`).
 * `cloneUrl` lets tests point at a local path instead of the network.
 */
export async function cloneShallow(
  repo: string,
  dest: string,
  cloneUrl?: string
): Promise<void> {
  const url = cloneUrl ?? `https://github.com/${repo}.git`;
  await exec("git", ["clone", "--depth", "1", url, dest], { maxBuffer: 50 * 1024 * 1024 });
}

/**
 * Read the remote HEAD SHA without cloning (`git ls-remote`). This is what
 * lets a re-entrant scan visit every corpus repo cheaply: an unchanged repo
 * costs one ref lookup instead of a full shallow clone.
 */
export async function remoteHeadSha(repo: string, cloneUrl?: string): Promise<string> {
  const url = cloneUrl ?? `https://github.com/${repo}.git`;
  const { stdout } = await exec("git", ["ls-remote", url, "HEAD"], { timeout: 60_000 });
  const sha = stdout.split(/\s/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`ls-remote returned no HEAD sha for ${url}`);
  }
  return sha;
}

/**
 * Fetch one commit (shallow) into an existing clone so it can be diffed
 * against HEAD. GitHub serves arbitrary reachable SHAs; a SHA that no longer
 * exists (history rewritten) throws, and the caller falls back to a full
 * analysis.
 */
export async function fetchCommitShallow(dir: string, sha: string): Promise<void> {
  await exec("git", ["fetch", "--depth", "1", "origin", sha], { cwd: dir, timeout: 300_000, maxBuffer: 50 * 1024 * 1024 });
}

/**
 * Hunk-level diff between two commits, renames disabled and zero context:
 * exactly the lines that changed, nothing more (parsed by phase/delta.ts).
 */
export async function diffHunks(dir: string, base: string, head: string): Promise<string> {
  const { stdout } = await exec("git", ["diff", "-U0", "--no-renames", "--no-color", base, head], {
    cwd: dir,
    maxBuffer: 200 * 1024 * 1024,
  });
  return stdout;
}

/** Read HEAD SHA of a git working dir. */
export async function headSha(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Detect the default branch name (e.g. `main`, `master`). */
export async function defaultBranch(dir: string): Promise<string> {
  const { stdout } = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/**
 * Create a temp working dir; returns { path, cleanup }.
 *
 * cleanup stops the lci index server for this root before removing the
 * directory. The candidates phase indexes whatever we clone here, and an lci
 * server outlives its client by design — so removing the directory first strands
 * that server forever, rooted at a path that no longer exists. See
 * `util/lci-server.ts` for what that cost in practice.
 */
export async function tempWorkDir(prefix = "errlookup-"): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      const stranded = stopLciServer(path);
      if (stranded.length > 0) {
        console.error(
          `[err-lookup] lci server(s) ${stranded.join(",")} still hold ${path}; ` +
            `reap with: kill -9 ${stranded.join(" ")}`,
        );
      }
      await rm(path, { recursive: true, force: true });
    },
  };
}
