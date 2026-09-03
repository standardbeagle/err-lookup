import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDb, type Db } from "../src/db/client.js";
import { getRepo, upsertRepo } from "../src/db/store.js";
import {
  seedQueue,
  claimNextQueued,
  reclaimRunningQueue,
  settleQueueItem,
  requeueInfraFailure,
  queueByStatus,
  FAILED_REQUEUE_COOLOFF_MS,
} from "../src/db/queue.js";
import { runScan, isInfraFailure, pickClaimKind } from "../src/scan.js";
import { ScriptedProvider } from "../src/provider/fixture.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => resolve(__dirname, "..", "fixtures", n);

const dbPath = resolve(".tmp-test", `scan-${process.pid}.db`);
let db: Db;
let raw: ReturnType<typeof openDb>["raw"];
let close: () => void;

beforeEach(() => {
  rmSync(dbPath, { force: true });
  const opened = openDb(dbPath);
  db = opened.db;
  raw = opened.raw;
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

function makeCfg(extraDefaults: string[] = []) {
  return mapConfig(
    parseKdl(
      ['provider "claude" { command "claude" }', "defaults {", '  primary "claude"', ...extraDefaults, "}"].join("\n")
    )
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

  it("failed repos wait out the cooloff before requeueing; done repos do not", () => {
    seedQueue(db, ["a/fails", "a/works"]);
    claimNextQueued(db);
    claimNextQueued(db);
    settleQueueItem(db, "a/fails", "failed", "discovery: boom");
    settleQueueItem(db, "a/works", "done");

    // Fresh failure: inside the cooloff window, only the done repo requeues.
    expect(seedQueue(db, ["a/fails", "a/works"])).toEqual({ added: 0, requeued: 1 });
    expect(queueByStatus(db, "failed").map((r) => r.repo)).toEqual(["a/fails"]);

    // Age the failure past the cooloff → it requeues again.
    raw
      .prepare("UPDATE queue SET updated_at = ? WHERE repo = 'a/fails'")
      .run(Date.now() - FAILED_REQUEUE_COOLOFF_MS - 1000);
    expect(seedQueue(db, ["a/fails"])).toEqual({ added: 0, requeued: 1 });
    close();
  });

  it("infra failures requeue immediately — no failed mark, no cooloff wait", () => {
    seedQueue(db, ["a/victim"]);
    const claimed = claimNextQueued(db)!;
    requeueInfraFailure(db, claimed.repo, "fatal: unable to create thread: Resource temporarily unavailable", 1);

    // Back to queued at level 1 with the error recorded — claimable in the
    // same drain, next attempt holds the large-repo slot.
    const row = queueByStatus(db, "queued")[0]!;
    expect(row.repo).toBe("a/victim");
    expect(row.solo).toBe(1);
    expect(row.lastError).toContain("unable to create thread");
    expect(queueByStatus(db, "failed")).toHaveLength(0);
    expect(claimNextQueued(db)?.repo).toBe("a/victim");
    close();
  });

  it("level-2 rows are invisible to the concurrent drain and reset on reseed", () => {
    seedQueue(db, ["a/exclusive"]);
    claimNextQueued(db);
    requeueInfraFailure(db, "a/exclusive", "spawn opencode EAGAIN", 2);

    // Concurrent workers must never claim an exclusive-retry row; only the
    // post-drain exclusive pass may, so the repo truly runs alone.
    expect(claimNextQueued(db)).toBeNull();
    const solo = claimNextQueued(db, "exclusive")!;
    expect(solo.repo).toBe("a/exclusive");
    expect(solo.solo).toBe(2);

    // A terminal settle + fresh seed returns the repo to best effort.
    settleQueueItem(db, "a/exclusive", "done");
    seedQueue(db, ["a/exclusive"]);
    expect(queueByStatus(db, "queued")[0]!.solo).toBe(0);
    close();
  });

  it("classifies host-resource and provider-spawn errors as infra, repo faults as not", () => {
    const infra = [
      "Command failed: git clone …\nfatal: unable to create thread: Resource temporarily unavailable",
      "error: cannot fork() for git-remote-https: Resource temporarily unavailable",
      "fatal: unable to access 'https://…': getaddrinfo() thread failed to start",
      "spawn opencode EAGAIN",
      "discovery: [spawn] glm ACP failure: Internal error: OpenCode service failure",
      "ENOSPC: no space left on device, write",
    ];
    for (const msg of infra) expect(isInfraFailure(msg), msg).toBe(true);

    const repoFault = [
      "discovery: [timeout] glm exceeded 600000ms (killed ACP process group)",
      "discovery: [parse] no JSON object in provider output",
      "fatal: could not read Username for 'https://github.com': No such device or address",
      "enrichment: [empty] provider returned nothing",
    ];
    for (const msg of repoFault) expect(isInfraFailure(msg), msg).toBe(false);
    close();
  });

  it("claims the preferred kind first — fresh or rescan — regardless of priority, then the other kind", () => {
    seedQueue(db, ["a/published", "a/fresh", "a/unpublished"]);
    // A published analysis exists for one repo; another has a row but never
    // finished (no analyzed_sha); the third has no repositories row at all.
    upsertRepo(db, { repo: "a/published", defaultBranch: "main", status: "analyzed", analyzedSha: "abc" });
    upsertRepo(db, { repo: "a/unpublished", defaultBranch: "main", status: "pending" });
    raw.prepare("UPDATE queue SET priority = 5 WHERE repo = 'a/published'").run();
    raw.prepare("UPDATE queue SET updated_at = updated_at - 1000 WHERE repo = 'a/unpublished'").run();

    expect(claimNextQueued(db, "concurrent", "rescan")?.repo).toBe("a/published");
    expect(claimNextQueued(db, "concurrent", "rescan")?.repo).toBe("a/unpublished");
    expect(claimNextQueued(db)?.repo).toBe("a/fresh");
    expect(claimNextQueued(db)).toBeNull();

    for (const r of ["a/published", "a/fresh", "a/unpublished"]) settleQueueItem(db, r, "done");
    seedQueue(db, ["a/published", "a/fresh", "a/unpublished"]);
    // Reseeding resets every row's age, so among the two never-analyzed
    // repos order is incidental; the published one still comes last.
    expect([claimNextQueued(db)?.repo, claimNextQueued(db)?.repo].sort()).toEqual(["a/fresh", "a/unpublished"]);
    expect(claimNextQueued(db)?.repo).toBe("a/published");
  });

  it("gives rescans their configured share of analysis starts", () => {
    const started = { fresh: 0, rescan: 0 };
    const picks: string[] = [];
    for (let i = 0; i < 8; i++) {
      const k = pickClaimKind(started, 0.25);
      picks.push(k);
      started[k]++;
    }
    expect(picks).toEqual(["fresh", "fresh", "fresh", "rescan", "fresh", "fresh", "fresh", "rescan"]);
    expect(pickClaimKind({ fresh: 0, rescan: 0 }, 0)).toBe("fresh");
    expect(pickClaimKind({ fresh: 100, rescan: 0 }, 0)).toBe("fresh");
    expect(pickClaimKind({ fresh: 0, rescan: 100 }, 1)).toBe("rescan");
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

describe("provider window quota", () => {
  /** A repo big enough that discovery actually calls the provider. */
  async function makeRepoWithSource(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "el-quota-"));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, `mod${i}.js`), `export function f${i}(x) {\n  if (!x) throw new Error('mod${i} needs x');\n}\n`);
    }
    await exec("git", ["init", "-q", "-b", "main", dir]);
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
    return dir;
  }

  class QuotaExhaustedProvider {
    readonly name = "claude";
    calls = 0;
    async invoke() {
      this.calls++;
      return {
        ok: false as const,
        kind: "spawn" as const,
        error:
          // The stamp must sit in the future at test time — a hardcoded date rotted
          // and failed this suite the day the calendar passed it.
          "scope: [spawn] glm ACP failure: Internal error: Usage limit reached for 5 hour. " +
          `Your limit will reset at ${new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ")}; stderr: Error handling request {`,
      };
    }
  }

  it("stops at the first spent-quota failure and reports when it is worth retrying", { timeout: 30_000 }, async () => {
    const local = await makeRepoWithSource();
    const p = new QuotaExhaustedProvider();
    const logs: string[] = [];
    const summary = await runScan({
      db,
      cfg: makeCfg(),
      corpus: ["a/one", "b/two", "c/three", "d/four"],
      providers: { claude: p },
      cloneUrlFor: () => local,
      onLog: (_repo, msg) => logs.push(msg),
    });

    // Every claim before the reset fails identically, so the drain must not
    // work through the queue proving it: one repo, not five to the breaker.
    // The stated stamp is clamped to the stated window (see usageLimitResetAt),
    // so assert the shape: a hold in the future, no further out than 5 hours.
    const hold = Date.parse(summary.providerHoldUntil!);
    expect(hold).toBeGreaterThan(Date.now());
    expect(hold).toBeLessThanOrEqual(Date.now() + 5 * 60 * 60 * 1000 + 1000);
    expect(summary.ok).toBe(0);
    expect(summary.leftQueued).toBeGreaterThanOrEqual(3);
    expect(logs.some((m) => m.includes("provider window quota is spent until"))).toBe(true);
    // One repo touched, not the whole corpus: the rest stay claimable for the
    // drain that runs after the reset.
    expect(summary.leftQueued).toBeGreaterThanOrEqual(3);
    close();
  });

  it("leaves the hold unset for an ordinary failure", { timeout: 30_000 }, async () => {
    const p = {
      name: "claude",
      async invoke() {
        return { ok: false as const, kind: "parse" as const, error: "bad json" };
      },
    };
    const local = await makeRepoWithSource();
    const summary = await runScan({
      db,
      cfg: makeCfg(),
      corpus: ["a/one"],
      providers: { claude: p },
      cloneUrlFor: () => local,
      onLog: () => {},
    });

    expect(summary.providerHoldUntil).toBeNull();
    close();
  });
});

describe("runtime budget", () => {
  /** A clock that is past the budget from the second reading on. */
  function clockPastBudgetAfterFirstRead(): () => number {
    let reads = 0;
    return () => (reads++ === 0 ? 1_000_000 : 1_000_000 + 10 * 60_000);
  }

  it("stops claiming at the budget and asks to be restarted, leaving the queue intact", async () => {
    const logs: string[] = [];
    const summary = await runScan({
      db,
      cfg: makeCfg(["  max-runtime-minutes 1"]),
      corpus: ["a/one", "b/two"],
      // A provider map that would throw if touched: nothing may be analyzed.
      providers: {},
      now: clockPastBudgetAfterFirstRead(),
      onLog: (_repo, msg) => logs.push(msg),
    });

    expect(summary.ok).toBe(0);
    expect(summary.stoppedForRestart).toBe(true);
    // The work is still there for the next drain — the budget is a handover,
    // not a failure, so nothing is marked failed or skipped.
    expect(summary.leftQueued).toBe(2);
    expect(summary.failed).toBe(0);
    expect(queueByStatus(db, "queued")).toHaveLength(2);
    expect(logs.some((m) => m.includes("runtime budget"))).toBe(true);
    close();
  });

  it("does not ask for a restart when the queue drained inside the budget", async () => {
    const local = await makeLocalRepo();
    const summary = await runScan({
      db,
      cfg: makeCfg(["  max-runtime-minutes 600"]),
      corpus: ["sindresorhus/is"],
      providers: makeProviders(),
      cloneUrlFor: () => local.path,
      onLog: () => {},
    });

    expect(summary.ok).toBe(1);
    expect(summary.stoppedForRestart).toBe(false);
    expect(summary.leftQueued).toBe(0);
    close();
    // 15s, not vitest's 5s default: a full fixture scan (clone, analysis,
    // integrate) runs ~3.5s alone but 6-7s while e2e.test.ts saturates the
    // box — the default flaked three suite runs in a row on 2026-09-03.
  }, 15_000);

  it("runs to the end of the queue when the budget is disabled", async () => {
    const summary = await runScan({
      db,
      cfg: makeCfg(["  max-runtime-minutes 0"]),
      corpus: ["a/one"],
      providers: {},
      // A clock far past any deadline: with the budget off it must not matter.
      now: () => Number.MAX_SAFE_INTEGER,
      onLog: () => {},
    });

    expect(summary.stoppedForRestart).toBe(false);
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
    // 15s: same suite-load margin as the runtime-budget test above.
  }, 15_000);

  it("dampens zero-yield repos: HEAD moves, but no ls-remote or re-analysis is spent", async () => {
    // A published zero-error analysis (docs-shaped repo) inside the damping
    // window skips even when HEAD changed. providers {} and no cloneUrlFor:
    // any network or provider touch would throw.
    upsertRepo(db, {
      repo: "docs/only",
      status: "analyzed",
      analyzedSha: "a".repeat(40),
      analyzedAt: new Date().toISOString(),
      errorCount: 0,
      defaultBranch: "main",
    });
    const summary = await runScan({ db, cfg: makeCfg(), corpus: ["docs/only"], providers: {}, onLog: () => {} });
    expect(summary.dampened).toBe(1);
    expect(summary.ok).toBe(0);
    expect(summary.failed).toBe(0);

    // Outside the window the damping releases (ls-remote then fails loudly
    // here because there is no real remote — the repo is attempted again).
    process.env.ERRLOOKUP_ZERO_YIELD_RESCAN_DAYS = "0";
    try {
      const again = await runScan({ db, cfg: makeCfg(), corpus: ["docs/only"], providers: {}, onLog: () => {} });
      expect(again.dampened).toBe(0);
    } finally {
      delete process.env.ERRLOOKUP_ZERO_YIELD_RESCAN_DAYS;
    }
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
