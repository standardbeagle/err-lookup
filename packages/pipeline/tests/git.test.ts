import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cloneShallow, headSha, defaultBranch, tempWorkDir } from "../src/vcs/git.js";

const exec = promisify(execFile);

async function makeBareRepo(): Promise<{ bare: string; sha: string; branch: string }> {
  // Create a local repo we can clone from (no network).
  const work = mkdtempSync(join(tmpdir(), "el-src-"));
  writeFileSync(join(work, "index.js"), "throw new Error('boom');\n");
  await exec("git", ["init", "-q", "-b", "main", work]);
  await exec("git", ["-C", work, "add", "."]);
  await exec("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const { stdout: sha } = await exec("git", ["-C", work, "rev-parse", "HEAD"]);
  return { bare: work, sha: sha.trim(), branch: "main" };
}

describe("git vcs", () => {
  it("clones shallow from a local path and reads HEAD sha", async () => {
    const src = await makeBareRepo();
    const dest = await tempWorkDir("el-clone-");
    try {
      await cloneShallow("ignored", dest.path, `${src.bare}`);
      const sha = await headSha(dest.path);
      expect(sha).toBe(src.sha);
      const branch = await defaultBranch(dest.path);
      expect(branch).toBe("main");
    } finally {
      dest.cleanup();
      rmSync(src.bare, { recursive: true, force: true });
    }
  }, 30000);
});
