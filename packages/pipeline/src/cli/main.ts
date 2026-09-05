#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { openDb } from "../db/client.js";
import { loadConfig } from "../config/index.js";
import { buildProviders } from "../providers.js";
import { analyzeRepo } from "../pipeline.js";
import { usageLimitResetAt } from "../provider/run.js";
import { runScan } from "../scan.js";
import { publishDataset, rowToErrorEntry } from "../exporter/index.js";
import { resetRepo, reposByStatus, purgeOrphanedJobs, errorBySlug, updateErrorFields, recordPhase } from "../db/store.js";
import { runReviewOne, parseReviewTarget } from "../phase/review.js";
import { collectInfoPages } from "../info/collector.js";
import { tagVocabulary } from "../phase/tag-vocabulary.js";
import { planTagBackfill, applyTagBackfill } from "../phase/tag-backfill.js";
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

  if (cmd === "collect-info") {
    const { values } = parseArgs({
      options: {
        "max-pages": { type: "string", default: "5" },
        "min-errors": { type: "string", default: "5" },
        "min-repos": { type: "string", default: "2" },
      },
      allowPositionals: true,
      args: rest,
    });
    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const { db, raw } = openDb(dbPath());
    try {
      const result = await collectInfoPages(db, providers, cfg, {
        maxPages: Number.parseInt(String(values["max-pages"]), 10),
        minErrors: Number.parseInt(String(values["min-errors"]), 10),
        minRepos: Number.parseInt(String(values["min-repos"]), 10),
        onLog: (m) => console.log(`  ${m}`),
      });
      console.log(
        `collect-info done: ${result.created.length} pages written` +
          (result.failed > 0 ? `, ${result.failed} failed` : "") +
          (result.remaining > 0 ? `, ~${result.remaining} clusters still unpaged` : "")
      );
      if (result.failed > 0) process.exit(1);
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "tags") {
    const { values } = parseArgs({
      options: {
        apply: { type: "boolean", default: false },
        limit: { type: "string", default: "40" },
      },
      allowPositionals: true,
      args: rest,
    });
    const { db, raw } = openDb(dbPath());
    try {
      const vocabulary = tagVocabulary(db);
      const covered = vocabulary.filter((f) => f.infoSlug !== null).length;
      const plan = planTagBackfill(db, vocabulary);
      console.log(
        `families: ${plan.familiesBefore} (${covered} with an article) → ${plan.familiesAfter} after folding`
      );
      console.log(`records that would change family: ${plan.recordsAffected}`);
      const limit = Number.parseInt(String(values.limit), 10);
      for (const m of plan.merges.slice(0, limit)) {
        console.log(`  ${m.errorCount.toString().padStart(6)}  ${m.from} → ${m.to}`);
      }
      if (plan.merges.length > limit) console.log(`  … ${plan.merges.length - limit} more`);
      if (plan.infoPageMoves.length > 0) {
        console.log(`articles following their family: ${plan.infoPageMoves.length}`);
        for (const m of plan.infoPageMoves) {
          console.log(`  /info/${m.slug}/  ${m.from} → ${m.to}${m.conflictsWith ? `  (conflict: ${m.conflictsWith} already covers it)` : ""}`);
        }
      }
      if (values.apply) {
        const res = applyTagBackfill(db, plan);
        console.log(`applied: ${res.recordsRewritten} records rewritten, ${res.pagesMoved} articles re-keyed`);
        for (const c of res.conflicts) {
          console.log(`  unresolved: /info/${c.slug}/ and /info/${c.conflictsWith}/ now describe ${c.to} — retire one by hand`);
        }
      } else if (plan.merges.length > 0) {
        console.log("dry run — pass --apply to rewrite");
      }
    } finally {
      raw.close();
    }
    return;
  }

  if (cmd === "review") {
    // Popularity-driven quality pass: deep-review the records behind the
    // site's most-visited pages. Targets come from scripts/report-top-pages.sh
    // or Search Console, as page URLs or owner/repo/slug.
    const { values } = parseArgs({
      options: { "dry-run": { type: "boolean", default: false } },
      allowPositionals: true,
      args: rest,
    });
    if (positional.length === 0) {
      console.error("usage: errlookup review [--dry-run] <page-url | owner/repo/slug>...");
      process.exit(2);
    }
    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const { db, raw } = openDb(dbPath());
    // The provider needs a cwd for its output-file handoff; reviews are
    // grounded in the stored record, so an empty scratch dir is the sandbox.
    const scratch = mkdtempSync(join(tmpdir(), "errlookup-review-"));
    let improved = 0;
    let defective = 0;
    let failed = 0;
    try {
      for (const target of positional) {
        const t = parseReviewTarget(target);
        if (!t) {
          console.error(`unparseable target (want page URL or owner/repo/slug): ${target}`);
          failed++;
          continue;
        }
        const row = errorBySlug(db, t.repo, t.slug);
        if (!row) {
          console.error(`no record for ${t.repo}/${t.slug}`);
          failed++;
          continue;
        }
        const entry = rowToErrorEntry(row);
        const started = Date.now();
        try {
          const r = await runReviewOne(entry, providers, cfg, scratch, (m) => console.log(`  ${m}`));
          console.log(`${t.repo}/${t.slug}: ${r.quality} via ${r.providerUsed} (${r.durationMs}ms)`);
          if (r.notes) console.log(`  ${r.notes}`);
          if (r.quality === "improved") improved++;
          if (r.quality === "defective") defective++;
          if (r.patches.length > 0) {
            console.log(`  fields: ${r.patches.map((p) => p.field).join(", ")}${values["dry-run"] ? " (dry-run, not written)" : ""}`);
          }
          if (!values["dry-run"]) {
            if (r.patches.length > 0) {
              updateErrorFields(db, entry.id, {
                documentation: r.entry.documentation,
                triggerScenarios: r.entry.triggerScenarios,
                commonSituations: r.entry.commonSituations,
                solutions: r.entry.solutions,
                exampleFix: r.entry.exampleFix,
                sourceCode: r.entry.sourceCode,
                filePath: r.entry.filePath,
              });
            }
            // Persist the verdict either way: reviews are provenance, and a
            // later rescan that rebuilds the records can replay them from here.
            recordPhase(db, {
              repo: t.repo,
              phase: "review",
              status: "success",
              startedAt: started,
              completedAt: Date.now(),
              analyzedSha: entry.analyzedSha,
              result: JSON.stringify({ slug: t.slug, quality: r.quality, notes: r.notes, patches: r.patches }),
            });
          }
        } catch (e) {
          console.error(`${t.repo}/${t.slug}: FAILED — ${(e as Error).message}`);
          failed++;
        }
      }
      console.log(
        `review done: ${positional.length - failed}/${positional.length} reviewed, ${improved} improved, ${defective} defective` +
          (values["dry-run"] ? " (dry-run)" : "")
      );
      if (defective > 0) console.log("defective records need a rescan or removal — see notes above");
      if (failed > 0) process.exit(1);
    } finally {
      raw.close();
      rmSync(scratch, { recursive: true, force: true });
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

  if (cmd === "ping") {
    // Cheapest possible call against the configured provider: does it answer?
    // Used to find out when a spent window has actually reopened, which the
    // provider's own reset stamp does not reliably say (see usageLimitResetAt).
    const { values } = parseArgs({
      options: { provider: { type: "string" }, "timeout-ms": { type: "string", default: "120000" } },
      allowPositionals: true,
      args: rest,
    });
    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const name = values.provider ?? cfg.defaults.primary;
    const provider = providers[name];
    if (!provider) {
      console.error(`no provider "${name}" in the config`);
      process.exit(2);
    }
    const cwd = mkdtempSync(join(tmpdir(), "errlookup-ping-"));
    const started = Date.now();
    try {
      const r = await provider.invoke('Reply with exactly this JSON and nothing else: {"ok":true}', {
        cwd,
        timeoutMs: Number.parseInt(String(values["timeout-ms"]), 10),
      });
      const took = Math.round((Date.now() - started) / 1000);
      if (r.ok) {
        console.log(`ping ${name}: ok (${took}s)`);
        return;
      }
      console.error(`ping ${name}: ${r.kind} after ${took}s — ${r.error.slice(0, 300)}`);
      // A spent window answers with its reset; the caller uses it to keep
      // holding rather than probing every hour for nothing.
      const reset = usageLimitResetAt(r.error);
      if (reset) console.error(`ping ${name}: quota still spent until ${reset.toISOString()}`);
      process.exit(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  if (cmd === "reverify") {
    // Re-run verify against a repo's PUBLISHED records: fill the gaps a failed
    // verify left without paying for discovery, enrichment and defense again.
    // `analyze --phases 5` cannot do this — an unlisted phase defaults to on,
    // so that command runs the whole pipeline.
    const { values } = parseArgs({
      options: { "clone-url": { type: "string" } },
      allowPositionals: true,
      args: rest,
    });
    if (positional.length === 0) {
      console.error("usage: errlookup reverify <owner/repo>...");
      process.exit(2);
    }
    const cfg = loadConfig();
    const providers = buildProviders(cfg);
    const { db, raw } = openDb(dbPath());
    let failed = 0;
    try {
      for (const repo of positional) {
        try {
          const result = await analyzeRepo(repo, {
            db,
            providers,
            cfg,
            phases: { scope: false, discovery: false, enrichment: false, defense: false, verify: true },
            force: true,
            cloneUrlOverride: values["clone-url"],
            onLog: (m) => console.log(`[${repo}] ${m}`),
          });
          console.log(`[${repo}] reverified: ${result.errorCount} records`);
        } catch (e) {
          failed++;
          console.error(`[${repo}] FAILED: ${(e as Error).message}`);
        }
      }
    } finally {
      raw.close();
    }
    if (failed > 0) process.exit(1);
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
            (summary.leftQueued > 0 ? `, ${summary.leftQueued} left queued` : "")
        );
        if (summary.providerHoldUntil) {
          // A file, not just a log line: the watchdog and the unit are shell,
          // and this is the one fact they need to not relaunch into a wall.
          const holdFile = join(
            process.env.ERRLOOKUP_LOG_DIR ?? join(homedir(), ".local", "state", "errlookup"),
            "provider-hold-until"
          );
          try {
            mkdirSync(dirname(holdFile), { recursive: true });
            writeFileSync(holdFile, `${summary.providerHoldUntil}\n`);
            console.log(`provider quota spent — holding relaunches until ${summary.providerHoldUntil}`);
          } catch (e) {
            console.error(`could not record the provider hold: ${(e as Error).message}`);
          }
        }
        if (summary.stoppedForRestart) {
          // 75 (EX_TEMPFAIL) means "work remains, start me again": the wrapper
          // and the systemd unit both restart on exactly this code, which is
          // how a deploy reaches a drain that would otherwise run for days.
          console.log(`scan stopped for restart with ${summary.leftQueued} queued — exiting 75`);
          raw.close();
          process.exit(75);
        }
      }
    } finally {
      raw.close();
    }
    return;
  }

  console.error("err-lookup pipeline. commands: analyze, scan, collect-info, tags, review, reset, export, status");
  console.error("  errlookup analyze <owner/repo> [--phases 1,2,3,4,5] [--force]");
  console.error("  errlookup review [--dry-run] <page-url | owner/repo/slug>...");
  console.error("  errlookup scan <file.txt> [--phases 1,2,3,5] [--force] [--seed-only]");
  console.error("  errlookup reverify <owner/repo>...   # verify pass over published records");
  console.error("  errlookup ping [--provider <name>]    # does the provider answer right now?");
  console.error("  errlookup collect-info [--max-pages 5] [--min-errors 5] [--min-repos 2]");
  console.error("  errlookup tags [--apply] [--limit 40]   report or fold the background-family vocabulary");
  console.error("  errlookup reset [--failed] [--dry-run] [owner/repo ...]");
  console.error("  errlookup export [--out-dir <path>]");
  console.error("  errlookup status");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
