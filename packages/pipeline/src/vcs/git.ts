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
