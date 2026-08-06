import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb, type Db } from "../src/db/client.js";
import { getRepo } from "../src/db/store.js";
import {
  seedQueue,
  claimNextQueued,
  reclaimRunningQueue,
  settleQueueItem,
  queueByStatus,
} from "../src/db/queue.js";
import { runScan } from "../src/scan.js";
import { ScriptedProvider } from "../src/provider/fixture.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => resolve(__dirname, "..", "fixtures", n);

const dbPath = resolve(".tmp-test", `scan-${process.pid}.db`);
let db: Db;
let close: () => void;

beforeEach(() => {
  rmSync(dbPath, { force: true });
  const opened = openDb(dbPath);
  db = opened.db;
  close = () => opened.raw.close();
});

async function makeLocalRepo(): Promise<{ path: string; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "el-scan-"));
  const indexJs =
    Array.from({ length: 17 }, (_, i) => `// line ${i + 1}`).join("\n") +
    "\nthrow new TypeError('Expected a function');\n";
  writeFileSync(join(dir, "index.js"), indexJs);
  await exec("git", ["init", "-q", "-b", "main", dir]);
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  return { path: dir, sha: stdout.trim() };
}

function makeCfg() {
  return mapConfig(
    parseKdl(['provider "claude" { command "claude" }', "defaults {", '  primary "claude"', "}"].join("\n"))
  );
}

function makeProviders() {
  return {
    claude: new ScriptedProvider("claude", [
      { match: ["EXPLAIN the error", "DEFEND against the error"], fixturePath: fx("provider-stdout-analysis.json") },
      { match: "EXPLAIN the error", fixturePath: fx("provider-stdout-enriched.json") },
      { match: "DEFEND against the error", fixturePath: fx("provider-stdout-defense.json") },
      { match: "Review these assembled", fixturePath: fx("provider-stdout-verify.json") },
      { match: "error patterns", fixturePath: fx("provider-stdout-clean.json") },
    ]),
  };
}

describe("re-entrant queue", () => {
  it("seed → claim → settle → reseed makes the repo eligible again", () => {
    expect(seedQueue(db, ["a/one", "a/two"])).toEqual({ added: 2, requeued: 0 });
    // Seeding again is a no-op while rows are queued.
    expect(seedQueue(db, ["a/one", "a/two"])).toEqual({ added: 0, requeued: 0 });

    const claimed = claimNextQueued(db)!;
    expect(claimed.status).toBe("running");
    expect(claimed.attempts).toBe(1);
    // Seeding never steals in-flight work.
    expect(seedQueue(db, [claimed.repo])).toEqual({ added: 0, requeued: 0 });

    settleQueueItem(db, claimed.repo, "done");
    // Terminal rows become eligible again on the next seed — this is what makes
    // each invocation pick up updates for every project.
    expect(seedQueue(db, [claimed.repo])).toEqual({ added: 0, requeued: 1 });
    close();
  });

  it("claims drain to empty and a dead scan's running rows are reclaimable", () => {
    seedQueue(db, ["a/one", "a/two"]);
    expect(claimNextQueued(db)).toBeTruthy();
    expect(claimNextQueued(db)).toBeTruthy();
    expect(claimNextQueued(db)).toBeNull();

    // Crash simulation: rows stuck in running.
    expect(reclaimRunningQueue(db)).toBe(2);
    expect(queueByStatus(db, "queued")).toHaveLength(2);
    close();
  });
});

describe("re-entrant scan", () => {
  it("analyzes a seeded repo, then skips it without cloning while HEAD is unchanged", async () => {
    const local = await makeLocalRepo();
    const cfg = makeCfg();
    const opts = {
      db,
      cfg,
      corpus: ["sindresorhus/is"],
      providers: makeProviders(),
      cloneUrlFor: () => local.path,
      onLog: () => {},
    };

    const first = await runScan(opts);
    expect(first.ok).toBe(1);
    expect(first.failed).toBe(0);
    expect(getRepo(db, "sindresorhus/is")?.status).toBe("analyzed");
    expect(getRepo(db, "sindresorhus/is")?.analyzedSha).toBe(local.sha);

    // Second scan: HEAD unchanged → settled as skipped via ls-remote, no clone,
    // no provider calls (a fresh provider map that would throw is never touched).
    const second = await runScan({ ...opts, providers: {} });
    expect(second.unchanged).toBe(1);
    expect(second.ok).toBe(0);
    expect(second.failed).toBe(0);
    expect(queueByStatus(db, "skipped")).toHaveLength(1);
    close();
  });

  it("seed-only enqueues without draining", async () => {
    const summary = await runScan({
      db,
      cfg: makeCfg(),
      corpus: ["a/one"],
      providers: {},
      seedOnly: true,
    });
    expect(summary.seeded.added).toBe(1);
    expect(queueByStatus(db, "queued")).toHaveLength(1);
    close();
  });
});
