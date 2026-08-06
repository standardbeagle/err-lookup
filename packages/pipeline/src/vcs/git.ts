import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Create a temp working dir; returns { path, cleanup }. */
export async function tempWorkDir(prefix = "errlookup-"): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
