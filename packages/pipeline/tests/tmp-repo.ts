import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopLciServer } from "../src/util/lci-server.js";

/**
 * Throwaway repo directories for tests, with the lci index server torn down.
 *
 * Tests hit the same leak production does — see `src/util/lci-server.ts` — but
 * far harder: every run creates a fresh mkdtemp root, so every run stranded one
 * more server. Of the 175 orphans found on beagle-ab2, 171 came from these
 * suites and 4 from the production clone path.
 *
 * Create test repos with `tmpRepo()` and release them with `disposeRepo()`,
 * never a bare `rmSync`: deleting the directory first strands the server.
 */
export function tmpRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function disposeRepo(dir: string): void {
  // Order matters: stop the server while its root still exists.
  const stranded = stopLciServer(dir);
  if (stranded.length > 0) {
    // Loud on purpose. A silent miss here is how 175 of these accumulated.
    console.error(
      `[tmp-repo] LEAK: lci server(s) ${stranded.join(",")} still hold ${dir}; ` +
        `reap with: kill -9 ${stranded.join(" ")}`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
}
