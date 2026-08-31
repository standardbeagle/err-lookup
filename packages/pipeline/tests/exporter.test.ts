import { gunzipSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDb } from "../src/db/client.js";
import { repositories, errors } from "../src/db/schema.js";
import { publishDataset, buildDataset, admitReposForSite } from "../src/exporter/index.js";
import { validateErrorEntry, validateRepoEntry } from "@errlookup/schema";
import { tmpDbPath } from "./setup.js";

function seed(db: ReturnType<typeof openDb>["db"]) {
  const sha = "a".repeat(40);
  db.insert(repositories)
    .values({
      repo: "axios/axios",
      description: "HTTP client",
      language: "JavaScript",
      stars: 100,
      defaultBranch: "main",
      analyzedSha: sha,
      analyzedAt: "2026-07-14T00:00:00Z",
      errorCount: 1,
      status: "analyzed",
    })
    .run();
  db.insert(errors)
    .values({
      id: "a1b2c3d4e5f60718",
      repo: "axios/axios",
      slug: "err-bad-response",
      errorCode: "ERR_BAD_RESPONSE",
      errorMessage: "Request failed with status code {status}",
      messagePattern: "Request failed with status code (.+?)",
      errorType: "http",
      errorClass: "AxiosError",
      httpStatus: 416,
      severity: "error",
      filePath: "lib/core/settle.js",
      lineNumber: 18,
      sourceCode: "throw new Error('x')",
      sourceCodeStart: 12,
      sourceCodeEnd: 20,
      githubUrl: `https://github.com/axios/axios/blob/${sha}/lib/core/settle.js#L18`,
      documentation: "doc",
      triggerScenarios: "trig",
      commonSituations: "common",
      solutions: ["fix1"],
      preventionTips: ["tip"],
      tags: ["http"],
      analyzedSha: sha,
      analyzedAt: "2026-07-14T00:00:00Z",
      schemaVersion: 2,
    })
    .run();
}

describe("exporter", () => {
  it("publishes a validated dataset atomically", () => {
    const dbPath = tmpDbPath("export");
    const { db, raw } = openDb(dbPath);
    seed(db);

    const outDir = resolve(".tmp-test", `export-out-${process.pid}`);
    rmSync(outDir, { recursive: true, force: true });

    const { counts, manifest } = publishDataset(db, { outDir });
    expect(counts.repos).toBe(1);
    expect(counts.errors).toBe(1);
    expect(counts.rejected).toBe(0);

    // All expected files present
    for (const rel of [
      "manifest.json",
      "index.json.gz",
      "repos.json",
      "repos/axios/axios.json",
    ]) {
      expect(existsSync(resolve(outDir, rel)), rel).toBe(true);
    }
    // No per-error files: they blew the Pages 20k-file deploy cap; single
    // records are served by /api/errors/:id from the per-repo file.
    expect(existsSync(resolve(outDir, "errors")), "errors/ dir").toBe(false);

    // manifest shape
    const m = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
    expect(m.schemaVersion).toBe(2);
    expect(m.counts).toEqual({ repos: 1, errors: 1, infoPages: 0, sitePublishedRepos: 1 });
    // Scheduled publishing: the crawl-surface admission list ships with the data.
    const published = JSON.parse(readFileSync(resolve(outDir, "published.json"), "utf8"));
    expect(published).toEqual(["axios/axios"]);
    expect(m.files.index.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((manifest as { datasetVersion: string }).datasetVersion).toBeTruthy();

    // index validates
    const index = JSON.parse(gunzipSync(readFileSync(resolve(outDir, "index.json.gz"))).toString("utf8"));
    expect(index.errors).toHaveLength(1);
    expect(index.errors[0].code).toBe("ERR_BAD_RESPONSE");

    // every published error record re-validates against the schema
    const repoFile = JSON.parse(readFileSync(resolve(outDir, "repos/axios/axios.json"), "utf8"));
    expect(repoFile).toHaveLength(1);
    expect(validateErrorEntry(repoFile[0]).ok).toBe(true);

    // repos.json validates
    const repos = JSON.parse(readFileSync(resolve(outDir, "repos.json"), "utf8"));
    expect(validateRepoEntry(repos[0]).ok).toBe(true);

    raw.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("second publish replaces the previous dataset", () => {
    const dbPath = tmpDbPath("export2");
    const { db, raw } = openDb(dbPath);
    seed(db);
    const outDir = resolve(".tmp-test", `export-replace-${process.pid}`);
    rmSync(outDir, { recursive: true, force: true });

    publishDataset(db, { outDir, datasetVersion: "2026-07-14T00:00:00Z" });
    const m1 = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
    publishDataset(db, { outDir, datasetVersion: "2026-07-15T00:00:00Z" });
    const m2 = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));

    expect(m2.datasetVersion).toBe("2026-07-15T00:00:00Z");
    expect(m2.datasetVersion).not.toBe(m1.datasetVersion);
    // no leftover .tmp / .old dirs
    const parent = resolve(outDir, "..");
    const siblings = readdirSync(parent).filter((n) => n.startsWith("export-replace"));
    expect(siblings).toEqual([resolve(outDir).split("/").pop()]);

    raw.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("buildDataset drops invalid records (rejected count)", () => {
    const dbPath = tmpDbPath("export-reject");
    const { db, raw } = openDb(dbPath);
    seed(db);
    // corrupt the slug directly (bypasses drizzle validation) so the record
    // fails ErrorEntry validation at export time.
    raw.prepare("UPDATE errors SET slug = 'UPPER' WHERE id = ?").run("a1b2c3d4e5f60718");

    const { counts } = buildDataset(db);
    expect(counts.rejected).toBe(1);
    expect(counts.errors).toBe(0);

    raw.close();
  });
});

describe("scheduled publishing (crawl-surface admission)", () => {
  function repoRow(repo: string, stars: number) {
    return {
      repo,
      description: null,
      language: "Go",
      stars,
      defaultBranch: "main",
      analyzedSha: "b".repeat(40),
      analyzedAt: "2026-08-30T00:00:00Z",
      errorCount: 0,
      status: "analyzed" as const,
    };
  }

  it("bootstraps by grandfathering every analyzed repo, then drips by daily budget", () => {
    const dbPath = tmpDbPath("export-admission");
    const { db, raw } = openDb(dbPath);
    seed(db);
    db.insert(repositories).values([repoRow("c/low", 1), repoRow("b/mid", 50), repoRow("a/high", 999)]).run();

    process.env.ERRLOOKUP_PUBLISH_NEW_REPOS_PER_DAY = "1";
    try {
      // First export ever: everything already analyzed is grandfathered — those
      // pages are live and indexed; noindexing them would be self-deindexing.
      const first = buildDataset(db);
      const firstPublished = JSON.parse(
        first.files.find((f) => f.relPath === "published.json")!.content as string
      );
      expect(firstPublished).toEqual(["a/high", "axios/axios", "b/mid", "c/low"]);

      // Bootstrap day spends the whole budget (the grandfathered rows carry
      // today's date), so newcomers analyzed the same day wait. On the next
      // day, 1/day admits only the starriest newcomer; a same-day re-run
      // admits no second one.
      db.insert(repositories).values([repoRow("d/new-big", 500), repoRow("e/new-small", 5)]).run();
      const sameDay = buildDataset(db);
      const sameDayPublished = JSON.parse(
        sameDay.files.find((f) => f.relPath === "published.json")!.content as string
      );
      expect(sameDayPublished).not.toContain("d/new-big");

      const newcomers = [
        { repo: "d/new-big", stars: 500 },
        { repo: "e/new-small", stars: 5 },
      ] as Parameters<typeof admitReposForSite>[1];
      const nextDay = new Date(Date.now() + 86_400_000);
      const admitted = admitReposForSite(db, newcomers, nextDay);
      expect(admitted.has("d/new-big")).toBe(true);
      expect(admitted.has("e/new-small")).toBe(false);
      const rerun = admitReposForSite(db, newcomers, nextDay);
      expect(rerun.has("e/new-small")).toBe(false);

      // The full dataset still ships every repo — admission gates crawl
      // exposure, never data availability.
      const after = buildDataset(db);
      const afterPublished = JSON.parse(
        after.files.find((f) => f.relPath === "published.json")!.content as string
      );
      expect(afterPublished).toContain("d/new-big");
      expect(afterPublished).not.toContain("e/new-small");
      const repos = JSON.parse(after.files.find((f) => f.relPath === "repos.json")!.content as string);
      expect(repos.map((r: { repo: string }) => r.repo)).toContain("e/new-small");
    } finally {
      delete process.env.ERRLOOKUP_PUBLISH_NEW_REPOS_PER_DAY;
      raw.close();
    }
  });
});

describe("default out dir", () => {
  it("resolves against the pnpm workspace root, not the package cwd", async () => {
    const { resolveDefaultOutDir } = await import("../src/exporter/index.js");
    const p = resolveDefaultOutDir();
    expect(p.endsWith("packages/site/public/data")).toBe(true);
    expect(p).not.toContain("packages/pipeline/packages");
  });
});
