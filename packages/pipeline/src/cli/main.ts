#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "../db/client.js";
import { loadConfig } from "../config/index.js";
import { buildProviders } from "../providers.js";
import { analyzeRepo } from "../pipeline.js";
import { publishDataset } from "../exporter/index.js";
import { mapPool } from "../util/pool.js";
import { msUntilOffPeak } from "../util/peak.js";
import { sleep } from "../util/watchdog.js";
import { resetRepo, reposByStatus, purgeOrphanedJobs } from "../db/store.js";
import { printStatus } from "./status.js";

function dbPath(): string {
  return process.env.ERRLOOKUP_DB ?? resolve(process.cwd(), "data", "errlookup.db");
}

const PHASE_NUM_TO_NAME: Record<number, string> = {
  1: "discovery",
  2: "enrichment",
  3: "defense",
  4: "cross-linking",
  5: "verify",
};
async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const positional = rest.filter((a) => !a.startsWith("-"));

  if (cmd === "analyze") {
    const { values } = parseArgs({
      options: {
        phases: { type: "string", default: "1,2" },
        force: { type: "boolean", default: false },
        "clone-url": { type: "string" },
      },
      allowPositionals: true,
      args: rest,
    });
    const repo = positional[0];
    if (!repo || !repo.includes("/")) {
      console.error("usage: errlookup analyze <owner/repo> [--phases 1,2,3,4,5] [--force]");
      process.exit(2);
    }
    const wantedPhases = String(values.phases)
      .split(",")
      .map((n) => PHASE_NUM_TO_NAME[Number.parseInt(n.trim(), 10)])
      .filter(Boolean) as ("discovery" | "enrichment")[];

    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const { db, raw } = openDb(dbPath());
    try {
      const result = await analyzeRepo(repo, {
        db,
        providers,
        cfg,
        phases: Object.fromEntries(wantedPhases.map((p) => [p, true])),
        force: values.force,
        cloneUrlOverride: values["clone-url"],
        onLog: (m) => console.log(`  ${m}`),
      });
      console.log(
        `done: ${result.errorCount} errors (skipped: ${result.skipped.join(",") || "none"}; rejects: ${result.rejects.length})`
      );
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "status") {
    const { db, raw } = openDb(dbPath());
    try {
      printStatus(db);
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "export") {
    const { values } = parseArgs({
      options: { "out-dir": { type: "string" } },
      allowPositionals: true,
      args: rest,
    });
    const { db, raw } = openDb(dbPath());
    try {
      const { manifest, counts } = publishDataset(db, {
        outDir: values["out-dir"] ? resolve(values["out-dir"]) : undefined,
      });
      console.log(
        `exported: ${counts.repos} repos, ${counts.errors} errors (${counts.rejected} rejected)\n${
          JSON.stringify(manifest, null, 2)
        }`
      );
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "reset") {
    const { values } = parseArgs({
      options: {
        failed: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: true,
      args: rest,
    });
    const { db, raw } = openDb(dbPath());
    try {
      // A repo in `analyzing` is owned by a live run — resetting it would delete
      // phase output that run is still writing to, and the run would then
      // reassemble from a half-empty history.
      const active = new Set(reposByStatus(db, "analyzing").map((r) => r.repo));
      const requested = new Set(positional);
      if (values.failed) for (const r of reposByStatus(db, "failed")) requested.add(r.repo);

      if (requested.size === 0) {
        console.error("usage: errlookup reset [--failed] [--dry-run] [owner/repo ...]");
        process.exit(2);
      }

      const targets = [...requested].filter((r) => !active.has(r));
      for (const skipped of [...requested].filter((r) => active.has(r))) {
        console.log(`skip ${skipped}: currently analyzing (a run owns this repo)`);
      }

      if (values["dry-run"]) {
        for (const repo of targets) console.log(`would reset ${repo}`);
        console.log(`dry run: ${targets.length} repos would return to pending`);
        return;
      }

      for (const repo of targets) {
        const s = resetRepo(db, repo);
        console.log(`reset ${s.repo}: ${s.errorsDeleted} errors, ${s.jobsDeleted} phase rows removed`);
      }
      const orphans = purgeOrphanedJobs(db, active);
      if (orphans > 0) console.log(`purged ${orphans} orphaned running-phase rows from crashed runs`);
      console.log(`reset ${targets.length} repos to pending`);
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "batch") {
    const { values } = parseArgs({
      options: {
        phases: { type: "string", default: "1,2,3,5" },
        force: { type: "boolean", default: false },
      },
      allowPositionals: true,
      args: rest,
    });
    const file = positional[0];
    if (!file) {
      console.error("usage: errlookup batch <file.txt>  # one owner/repo per line");
      process.exit(2);
    }
    const repos = readFileSync(resolve(file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const wantedPhases = String(values.phases)
      .split(",")
      .map((n) => PHASE_NUM_TO_NAME[Number.parseInt(n.trim(), 10)])
      .filter(Boolean) as string[];
    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const { db, raw } = openDb(dbPath());
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    // Circuit breaker: provider quota exhaustion fails every repo the same way;
    // stop burning clones and let the next scheduled run resume (§11.2). With
    // repos in flight concurrently, "consecutive" means consecutive completions
    // — repos already running are allowed to finish.
    let consecutiveFailures = 0;
    const BREAKER = 5;
    let tripped = false;

    // Concurrent repos interleave their output, so every line carries its repo.
    // The scheduled runs grep these logs; an unattributed line is useless there.
    const say = (repo: string, msg: string) => console.log(`[${repo}] ${msg}`);
    const complain = (repo: string, msg: string) => console.error(`[${repo}] ${msg}`);

    try {
      console.log(
        `batch: ${repos.length} repos, ${cfg.defaults.maxConcurrent} concurrent, ` +
          `${cfg.defaults.batchConcurrency} calls/phase, ${cfg.defaults.analysisBatchSize} errors/call`
      );
      await mapPool(repos, cfg.defaults.maxConcurrent, async (repo) => {
        if (tripped) {
          skipped++;
          return;
        }
        // Peak-price gate. Checked between repos, never mid-repo: interrupting a
        // repo would abandon an in-flight phase and re-spend it on resume, which
        // costs more than the 2x rate it was avoiding.
        if (cfg.defaults.skipPeak) {
          const waitMs = msUntilOffPeak(new Date());
          if (waitMs > 0) {
            say(repo, `peak pricing until ${new Date(Date.now() + waitMs).toISOString()} — holding`);
            await sleep(waitMs);
          }
        }
        say(repo, "start");
        try {
          const r = await analyzeRepo(repo, {
            db,
            providers,
            cfg,
            phases: Object.fromEntries(wantedPhases.map((p) => [p, true])),
            force: values.force,
            onLog: (m) => say(repo, m),
          });
          if (r.failed) {
            complain(repo, `FAILED: ${r.failed}`);
            failed++;
            consecutiveFailures++;
          } else {
            say(repo, `→ ${r.errorCount} errors`);
            ok++;
            consecutiveFailures = 0;
          }
        } catch (e) {
          complain(repo, `FAILED: ${(e as Error).message}`);
          failed++;
          consecutiveFailures++;
        }
        if (consecutiveFailures >= BREAKER && !tripped) {
          tripped = true;
          console.error(
            `batch aborted: ${BREAKER} consecutive failures — provider likely rate-limited/exhausted`
          );
        }
      });
      console.log(
        `\nbatch done: ${ok} ok, ${failed} failed${tripped ? `, ${skipped} skipped (breaker tripped)` : ""}`
      );
    } finally {
      raw.close();
    }
    return;
  }

  console.error("err-lookup pipeline. commands: analyze, batch, reset, export, status");
  console.error("  errlookup analyze <owner/repo> [--phases 1,2,3,4,5] [--force]");
  console.error("  errlookup batch <file.txt> [--phases 1,2,3,5] [--force]");
  console.error("  errlookup reset [--failed] [--dry-run] [owner/repo ...]");
  console.error("  errlookup export [--out-dir <path>]");
  console.error("  errlookup status");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
