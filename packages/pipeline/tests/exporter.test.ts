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

  it("rolls each repo's sitemap lastmod up into repos.json, ignoring unindexable records", () => {
    const dbPath = tmpDbPath("export-lastmod");
    const { db, raw } = openDb(dbPath);
    seed(db);
    // The seeded record is indexable and content-dated. A thin stub dated
    // later must not raise the repo's lastmod: it earns no sitemap line, so
    // the index would be claiming a change to a document that omits it.
    raw
      .prepare("UPDATE errors SET content_changed_at = ? WHERE id = ?")
      .run("2026-08-02T00:00:00Z", "a1b2c3d4e5f60718");
    db.insert(errors)
      .values({
        id: "b1b2c3d4e5f60718",
        repo: "axios/axios",
        slug: "thin-stub",
        errorCode: null,
        errorMessage: "other failure",
        messagePattern: "other failure",
        errorType: "exception",
        errorClass: null,
        httpStatus: null,
        severity: "error",
        filePath: "lib/other.js",
        lineNumber: 3,
        sourceCode: "throw new Error('y')",
        sourceCodeStart: 1,
        sourceCodeEnd: 5,
        githubUrl: `https://github.com/axios/axios/blob/${"a".repeat(40)}/lib/other.js#L3`,
        documentation: "stub",
        triggerScenarios: "trig",
        commonSituations: "common",
        solutions: [],
        preventionTips: [],
        tags: [],
        analyzedSha: "a".repeat(40),
        analyzedAt: "2026-07-14T00:00:00Z",
        contentChangedAt: "2026-09-09T00:00:00Z",
        schemaVersion: 2,
      })
      .run();

    const { files, counts } = buildDataset(db);
    expect(counts.rejected).toBe(0);
    const reposOut = JSON.parse(
      files.find((f) => f.relPath === "repos.json")!.content as string
    ) as { repo: string; contentChangedAt: string | null }[];
    expect(reposOut).toHaveLength(1);
    expect(reposOut[0]!.contentChangedAt).toBe("2026-08-02T00:00:00Z");

    raw.close();
  });

  it("leaves the rollup null when a repo has no indexable record", () => {
    const dbPath = tmpDbPath("export-lastmod-null");
    const { db, raw } = openDb(dbPath);
    seed(db);
    // Thin: stub documentation and no solutions. The site falls back to the
    // repo's own analyzedAt — there is no content signal to report.
    raw
      .prepare("UPDATE errors SET documentation = 'stub', solutions = '[]' WHERE id = ?")
      .run("a1b2c3d4e5f60718");

    const { files } = buildDataset(db);
    const reposOut = JSON.parse(
      files.find((f) => f.relPath === "repos.json")!.content as string
    ) as { contentChangedAt: string | null }[];
    expect(reposOut[0]!.contentChangedAt).toBeNull();

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

  it("bootstraps by grandfathering every analyzed repo, then admits after the delay", () => {
    const dbPath = tmpDbPath("export-admission");
    const { db, raw } = openDb(dbPath);
    seed(db);
    db.insert(repositories).values([repoRow("c/low", 1), repoRow("b/mid", 50), repoRow("a/high", 999)]).run();

    try {
      // First export ever: everything already analyzed is grandfathered — those
      // pages are live and indexed; noindexing them would be self-deindexing.
      const first = buildDataset(db);
      const firstPublished = JSON.parse(
        first.files.find((f) => f.relPath === "published.json")!.content as string
      );
      expect(firstPublished).toEqual(["a/high", "axios/axios", "b/mid", "c/low"]);
      // ...and stays admitted on the very next export (the backdate must clear
      // the delay window, not sit exactly on its edge).
      const again = buildDataset(db);
      expect(
        JSON.parse(again.files.find((f) => f.relPath === "published.json")!.content as string)
      ).toEqual(["a/high", "axios/axios", "b/mid", "c/low"]);

      // A repo analyzed after bootstrap waits out the delay — a time shift,
      // not a quota, so admission tracks analysis pace exactly.
      db.insert(repositories).values([repoRow("d/new", 500)]).run();
      const sameDay = buildDataset(db);
      expect(
        JSON.parse(sameDay.files.find((f) => f.relPath === "published.json")!.content as string)
      ).not.toContain("d/new");

      const newcomer = [{ repo: "d/new", stars: 500 }] as Parameters<typeof admitReposForSite>[1];
      const beforeDelay = new Date(Date.now() + 6 * 86_400_000);
      expect(admitReposForSite(db, newcomer, beforeDelay).has("d/new")).toBe(false);
      const afterDelay = new Date(Date.now() + 8 * 86_400_000);
      expect(admitReposForSite(db, newcomer, afterDelay).has("d/new")).toBe(true);

      // The full dataset still ships every repo — admission gates crawl
      // exposure, never data availability.
      const repos = JSON.parse(sameDay.files.find((f) => f.relPath === "repos.json")!.content as string);
      expect(repos.map((r: { repo: string }) => r.repo)).toContain("d/new");
    } finally {
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
