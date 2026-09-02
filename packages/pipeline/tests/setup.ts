import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";

// Each vitest worker gets a private provider-gate dir: the real machine-wide
// gate spans processes by design, and parallel workers sharing it would
// contend for slots exactly like a drain beside a sweep.
process.env.ERRLOOKUP_PROVIDER_GATE_DIR = join(tmpdir(), `errlookup-gate-test-${process.pid}`);

// Each test file uses its own temp DB via tmp(); this is a safety net for
// any process-global state. individual tests create/destroy their own DBs.
export function tmpDbPath(name: string): string {
  const path = resolve(process.cwd(), ".tmp-test", `${name}-${process.pid}.db`);
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  return path;
}

afterEach(() => {
  // no-op for now; cleanup is per-test
});
