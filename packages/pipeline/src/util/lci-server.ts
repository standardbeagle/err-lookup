import { execFileSync } from "node:child_process";

/**
 * Stop the lci index server rooted at a directory that is about to be deleted.
 *
 * `lci -r <root> grep` — the candidates phase's backend — starts a PERSISTENT
 * per-root index server that outlives the client. In production against a real
 * checkout that is exactly what you want: the warm index is the reason lci is
 * fast. But the pipeline clones into a temp dir (`tempWorkDir`), indexes it, and
 * then removes it — and lci has no idle timeout, so the server stays alive
 * forever, rooted at a path that no longer exists. It cannot be reached, cannot
 * be reused, and holds memory, threads, and file watches until reboot.
 *
 * Observed on beagle-ab2 2026-08-08: 175 such orphans, up to 3d20h old, ~1.1GB
 * RSS and ~3,200 threads between them — enough to push the box into swap.
 * Measured effect on an unrelated tool's startup: 4.5-10.3s before reaping the
 * orphans, 1.6-1.9s after.
 *
 * Signals the process directly instead of calling `lci shutdown`, which does not
 * work as of lci 2026-08-08 — it reports
 *
 *     Shutting down server for root: /tmp/x
 *     Error: server did not shut down            (exit 1)
 *
 * and leaves the server running. Once that is fixed this can collapse to one
 * call. Until then, calling it and ignoring the non-zero exit is precisely how
 * the leak went unnoticed, so this verifies the process is actually gone and
 * reports what it could not stop.
 *
 * Call this BEFORE removing the directory: once the root is gone, the server can
 * no longer be identified with certainty.
 *
 * @returns PIDs it could not stop (empty on success).
 */
export function stopLciServer(root: string): number[] {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = lciServerPids(root);
    if (pids.length === 0) return [];
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Exited between listing and signalling — the intended outcome.
      }
    }
    pauseSync(250);
  }
  return lciServerPids(root);
}

/**
 * PIDs of lci servers whose root is exactly `root`.
 *
 * Compares `--root`/`-r`'s value for equality rather than matching a substring.
 * A substring match would be a live hazard: `/tmp/cand-` is a prefix of every
 * sibling fixture's root, so it would kill a concurrently running job's server.
 */
function lciServerPids(root: string): number[] {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch {
    return []; // no usable ps; nothing identifiable to stop
  }
  const pids: number[] = [];
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tokens = m[2]!.split(/\s+/);
    const bin = tokens[0] ?? "";
    if (!(bin === "lci" || bin.endsWith("/lci"))) continue;
    const i = tokens.findIndex((t) => t === "--root" || t === "-r");
    if (i >= 0 && tokens[i + 1] === root) pids.push(Number(m[1]));
  }
  return pids;
}

/** Block briefly; cleanup runs in both sync test hooks and async teardown. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
