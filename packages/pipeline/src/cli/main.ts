#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openDb } from "../db/client.js";
import { loadConfig } from "../config/index.js";
import { buildProviders } from "../providers.js";
import { analyzeRepo } from "../pipeline.js";
import { runScan } from "../scan.js";
import { publishDataset } from "../exporter/index.js";
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

  if (cmd === "scan") {
    const { values } = parseArgs({
      options: {
        phases: { type: "string", default: "1,2,3,5" },
        force: { type: "boolean", default: false },
        "seed-only": { type: "boolean", default: false },
      },
      allowPositionals: true,
      args: rest,
    });
    const file = positional[0];
    if (!file) {
      console.error("usage: errlookup scan <file.txt> [--seed-only]  # one owner/repo per line");
      process.exit(2);
    }
    const corpus = readFileSync(resolve(file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const wantedPhases = String(values.phases)
      .split(",")
      .map((n) => PHASE_NUM_TO_NAME[Number.parseInt(n.trim(), 10)])
      .filter(Boolean) as string[];
    const cfg = loadConfig();
    const { db, raw } = openDb(dbPath());
    try {
      if (!values["seed-only"]) {
        console.log(
          `scan: ${corpus.length} corpus repos, ${cfg.defaults.maxConcurrent} concurrent, ` +
            `${cfg.defaults.batchConcurrency} calls/phase, ${cfg.defaults.analysisBatchSize} errors/call`
        );
      }
      const summary = await runScan({
        db,
        providers: values["seed-only"] ? {} : buildProviders(cfg),
        cfg,
        corpus,
        phases: Object.fromEntries(wantedPhases.map((p) => [p, true])),
        force: values.force,
        seedOnly: values["seed-only"],
        // Concurrent repos interleave their output, so every line carries its
        // repo. The scheduled runs grep these logs.
        onLog: (repo, msg) => console.log(`[${repo}] ${msg}`),
      });
      if (values["seed-only"]) {
        console.log(`seeded: ${summary.seeded.added} added, ${summary.seeded.requeued} requeued`);
      } else {
        console.log(
          `\nscan done: ${summary.ok} ok, ${summary.unchanged} unchanged, ${summary.failed} failed` +
            (summary.leftQueued > 0 ? `, ${summary.leftQueued} left queued (breaker)` : "")
        );
      }
    } finally {
      raw.close();
    }
    return;
  }

  console.error("err-lookup pipeline. commands: analyze, scan, reset, export, status");
  console.error("  errlookup analyze <owner/repo> [--phases 1,2,3,4,5] [--force]");
  console.error("  errlookup scan <file.txt> [--phases 1,2,3,5] [--force] [--seed-only]");
  console.error("  errlookup reset [--failed] [--dry-run] [owner/repo ...]");
  console.error("  errlookup export [--out-dir <path>]");
  console.error("  errlookup status");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
