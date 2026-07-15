import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach } from "vitest";

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
