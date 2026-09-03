import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, type Db } from "../src/db/client.js";
import {
  upsertRepo,
  getRepo,
  replaceErrors,
  errorsForRepo,
  integrateAnalyzedVersion,
  recordAnalysisFailure,
} from "../src/db/store.js";
import { readDataset } from "../src/exporter/index.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";

const dbPath = resolve(".tmp-test", `versioning-${process.pid}.db`);
let db: Db;
let close: () => void;

function errorRow(repo: string, sha: string, slug: string) {
  return {
    id: `${slug.replace(/\W/g, "").slice(0, 16).padEnd(16, "0")}`,
    repo,
    slug,
    errorCode: null,
    errorMessage: `${slug} boom`,
    messagePattern: `${slug} boom`,
    errorType: "exception",
    errorClass: null,
    httpStatus: null,
    severity: "error",
    filePath: "a.js",
    lineNumber: 1,
    sourceCode: null,
    sourceCodeStart: null,
    sourceCodeEnd: null,
    githubUrl: `https://github.com/${repo}/blob/${sha}/a.js#L1`,
    documentation: "d",
    triggerScenarios: "t",
    commonSituations: "c",
    solutions: ["s"],
    exampleFix: null,
    handlingStrategy: null,
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: [],
    tags: [],
    analyzedSha: sha,
    analyzedAt: "2026-08-01T00:00:00.000Z",
    schemaVersion: 2,
  };
}

const V1_SHA = "a".repeat(40);
const V2_SHA = "b".repeat(40);

function seedPublishedRepo(repo: string) {
  upsertRepo(db, {
    repo,
    status: "analyzed",
    analyzedSha: V1_SHA,
    analyzedAt: "2026-08-01T00:00:00.000Z",
    errorCount: 1,
  });
  replaceErrors(db, repo, [errorRow(repo, V1_SHA, "v1-err")]);
}

beforeEach(() => {
  rmSync(dbPath, { force: true });
  const opened = openDb(dbPath);
  db = opened.db;
  close = () => opened.raw.close();
});

describe("version-aware analysis integration", () => {
  it("a failed re-analysis keeps the published version exportable", () => {
    seedPublishedRepo("golang/go");

    recordAnalysisFailure(db, "golang/go", "discovery: operation timed out");

    const row = getRepo(db, "golang/go")!;
    expect(row.status).toBe("analyzed");
    expect(row.analyzedSha).toBe(V1_SHA);
    expect(row.lastError).toBe("discovery: operation timed out");
    expect(errorsForRepo(db, "golang/go")).toHaveLength(1);

    const { repos, errorsByRepo } = readDataset(db);
    expect(repos.map((r) => r.repo)).toContain("golang/go");
    expect(errorsByRepo.get("golang/go")).toHaveLength(1);
    close();
  });

  it("a repo with nothing published is demoted to failed", () => {
    upsertRepo(db, { repo: "new/repo", status: "pending" });

    recordAnalysisFailure(db, "new/repo", "discovery: boom");

    const row = getRepo(db, "new/repo")!;
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("discovery: boom");
    expect(readDataset(db).repos).toHaveLength(0);
    close();
  });

  it("publishes the new version and carries a record this run missed", () => {
    seedPublishedRepo("golang/go");

    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [
      errorRow("golang/go", V2_SHA, "v2-err-1"),
      errorRow("golang/go", V2_SHA, "v2-err-2"),
    ]);

    const row = getRepo(db, "golang/go")!;
    expect(row.status).toBe("analyzed");
    expect(row.analyzedSha).toBe(V2_SHA);
    expect(row.lastError).toBeNull();

    // v1-err was published and is therefore indexed; one analysis that did not
    // rediscover it is not grounds to turn its URL into a 404.
    const records = errorsForRepo(db, "golang/go");
    expect(records.map((r) => r.slug).sort()).toEqual(["v1-err", "v2-err-1", "v2-err-2"]);
    expect(records.find((r) => r.slug === "v1-err")!.missedRuns).toBe(1);
    expect(records.filter((r) => r.analyzedSha === V2_SHA)).toHaveLength(2);
    expect(row.errorCount).toBe(3);
    close();
  });

  it("never withdraws a published record, however many analyses miss it", () => {
    seedPublishedRepo("golang/go");

    // Five analyses in a row fail to rediscover v1-err. Its page stays up
    // through all of them: an LLM pass that stopped seeing an error says
    // nothing about whether the error is real, and the URL is indexed.
    for (const sha of ["c", "d", "e", "f", "0"].map((c) => c.repeat(40))) {
      integrateAnalyzedVersion(db, "golang/go", sha, [errorRow("golang/go", sha, "live")]);
      expect(errorsForRepo(db, "golang/go").map((r) => r.slug).sort()).toEqual(["live", "v1-err"]);
    }

    // The count is a staleness marker for the fill-in pass, not a countdown.
    expect(errorsForRepo(db, "golang/go").find((r) => r.slug === "v1-err")!.missedRuns).toBe(5);
    expect(getRepo(db, "golang/go")?.errorCount).toBe(2);
    close();
  });

  it("clears the miss counter when a later run finds the record again", () => {
    seedPublishedRepo("golang/go");
    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [errorRow("golang/go", V2_SHA, "live")]);
    expect(errorsForRepo(db, "golang/go").find((r) => r.slug === "v1-err")!.missedRuns).toBe(1);

    const sha3 = "c".repeat(40);
    integrateAnalyzedVersion(db, "golang/go", sha3, [
      errorRow("golang/go", sha3, "live"),
      errorRow("golang/go", sha3, "v1-err"),
    ]);

    // Rediscovery is proof the record is live: without the reset, two more
    // flaky runs could retire a page that a run in between had confirmed.
    expect(errorsForRepo(db, "golang/go").find((r) => r.slug === "v1-err")!.missedRuns).toBe(0);
    close();
  });

  it("integrates a repo whose record count exceeds one statement's variable limit", () => {
    // elasticsearch produced 1,352 records; at ~30 bound variables per row a
    // single INSERT blew SQLite's 32,766-variable cap and the whole analysis
    // was discarded ("too many SQL variables"). 1,400 rows must integrate.
    seedPublishedRepo("elastic/elasticsearch");
    const rows = Array.from({ length: 1400 }, (_, i) =>
      errorRow("elastic/elasticsearch", V2_SHA, `es-err-${String(i).padStart(4, "0")}`)
    );

    integrateAnalyzedVersion(db, "elastic/elasticsearch", V2_SHA, rows);

    const row = getRepo(db, "elastic/elasticsearch")!;
    expect(row.status).toBe("analyzed");
    // 1,400 new plus the seeded record this run did not rediscover.
    expect(row.errorCount).toBe(1401);
    expect(errorsForRepo(db, "elastic/elasticsearch")).toHaveLength(1401);

    // replaceErrors shares the chunked path — the direct call must survive too.
    replaceErrors(db, "elastic/elasticsearch", rows.slice(0, 1100));
    expect(errorsForRepo(db, "elastic/elasticsearch")).toHaveLength(1100);
    close();
  });

  it("integrating an empty result is a valid published version", () => {
    seedPublishedRepo("clean/repo");

    integrateAnalyzedVersion(db, "clean/repo", V2_SHA, []);

    const row = getRepo(db, "clean/repo")!;
    expect(row.status).toBe("analyzed");
    expect(row.analyzedSha).toBe(V2_SHA);
    // A run that found nothing is the commonest flake of all — a failed
    // discovery batch looks exactly like a repo with no errors — and the
    // published page set survives it intact.
    expect(row.errorCount).toBe(1);
    expect(errorsForRepo(db, "clean/repo").map((r) => r.slug)).toEqual(["v1-err"]);
    close();
  });

  it("a repo with nothing published integrates an empty result as empty", () => {
    integrateAnalyzedVersion(db, "brand/new", V2_SHA, []);

    expect(getRepo(db, "brand/new")?.errorCount).toBe(0);
    expect(errorsForRepo(db, "brand/new")).toHaveLength(0);
    close();
  });
});

describe("honest lastmod (contentChangedAt)", () => {
  it("keeps contentChangedAt across re-analyses with identical content, bumps it on change", () => {
    const V3_SHA = "c".repeat(40);
    const first = { ...errorRow("golang/go", V2_SHA, "stable"), analyzedAt: "2026-09-01T00:00:00.000Z" };
    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [first]);
    const afterFirst = errorsForRepo(db, "golang/go")[0]!;
    expect(afterFirst.contentChangedAt).toBe("2026-09-01T00:00:00.000Z");

    // Same content re-analyzed at a new sha/date: analyzedAt moves, the
    // sitemap's date must not — lastmod churn on unchanged pages is what
    // eroded crawler trust during the Aug-17-20 requeue stall.
    const second = { ...errorRow("golang/go", V3_SHA, "stable"), analyzedAt: "2026-09-02T00:00:00.000Z", githubUrl: first.githubUrl };
    integrateAnalyzedVersion(db, "golang/go", V3_SHA, [second]);
    const afterSecond = errorsForRepo(db, "golang/go")[0]!;
    expect(afterSecond.analyzedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(afterSecond.contentChangedAt).toBe("2026-09-01T00:00:00.000Z");

    // A real content change moves the date.
    const third = { ...second, analyzedAt: "2026-09-03T00:00:00.000Z", documentation: "rewritten, longer, better" };
    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [third]);
    expect(errorsForRepo(db, "golang/go")[0]!.contentChangedAt).toBe("2026-09-03T00:00:00.000Z");
  });

  it("moved code is not changed content: location fields stay out of the hash", () => {
    const first = { ...errorRow("golang/go", V2_SHA, "moving"), analyzedAt: "2026-09-01T00:00:00.000Z" };
    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [first]);
    const moved = {
      ...first,
      analyzedAt: "2026-09-02T00:00:00.000Z",
      filePath: "b.js",
      lineNumber: 99,
      githubUrl: first.githubUrl.replace("a.js#L1", "b.js#L99"),
    };
    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [moved]);
    expect(errorsForRepo(db, "golang/go")[0]!.contentChangedAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("verify-only re-run", () => {
  it("patches the published records instead of republishing an empty version", async () => {
    const { analyzeRepo } = await import("../src/pipeline.js");
    const { tmpRepo, disposeRepo } = await import("./tmp-repo.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);

    const src = tmpRepo("el-verify-only-");
    writeFileSync(join(src, "a.js"), "throw new Error('boom');\n");
    await exec("git", ["init", "-q", "-b", "main", src]);
    await exec("git", ["-C", src, "add", "."]);
    await exec("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1"]);
    const { stdout } = await exec("git", ["-C", src, "rev-parse", "HEAD"]);
    const sha = stdout.trim();

    const repo = "acme/gappy";
    upsertRepo(db, { repo, status: "analyzed", analyzedSha: sha, analyzedAt: "2026-08-17T00:00:00.000Z", errorCount: 2 });
    // Missing documentation only: a record still invalid after patching is
    // dropped by verify's revalidation, which is a different hole (now caught
    // by the miss counter rather than deleting the page).
    // Ids must be the real 16-hex shape: validateErrorEntry rejects anything
    // else, and a rejected record is dropped by verify's revalidation.
    const gappy = { ...errorRow(repo, sha, "gappy"), id: "a".repeat(16), documentation: null };
    replaceErrors(db, repo, [{ ...errorRow(repo, sha, "documented"), id: "b".repeat(16) }, gappy]);

    // The recipe docs/verify-debt-2026-08-16.txt gave for the K3 outage. With
    // discovery off there is nothing to assemble, so before this the run
    // republished the repo with zero records and every page went with it.
    const patches = [{ id: gappy.id, field: "documentation", value: "filled in" }];
    const provider = {
      name: "p",
      async invoke() {
        return { ok: true as const, parsed: { patches }, raw: JSON.stringify({ patches }) };
      },
    };
    const cfg = mapConfig(parseKdl(['provider "p" { command "p" }', "defaults {", '  primary "p"', "}"].join("\n")));

    const logs: string[] = [];
    const r = await analyzeRepo(repo, {
      db,
      providers: { p: provider },
      cfg,
      phases: { scope: false, discovery: false, enrichment: false, defense: false, verify: true },
      force: true,
      cloneUrlOverride: src,
      onLog: (m) => logs.push(m),
    });
    expect(logs.join("\n")).toContain("verify-only: 2 published records");

    expect(r.failed).toBeUndefined();
    const rows = errorsForRepo(db, repo);
    expect(rows.map((x) => x.slug).sort()).toEqual(["documented", "gappy"]);
    expect(rows.find((x) => x.slug === "gappy")!.documentation).toBe("filled in");
    expect(getRepo(db, repo)?.errorCount).toBe(2);
    disposeRepo(src);
    close();
  }, 60_000);
});

describe("a discovery that found nothing because everything failed", () => {
  it("fails the repo instead of publishing it as having no errors", async () => {
    const { analyzeRepo } = await import("../src/pipeline.js");
    const { tmpRepo, disposeRepo } = await import("./tmp-repo.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);

    const src = tmpRepo("el-allfail-");
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(src, `m${i}.js`), `export function f${i}(x) {\n  if (!x) throw new Error('m${i} needs x');\n}\n`);
    }
    await exec("git", ["init", "-q", "-b", "main", src]);
    await exec("git", ["-C", src, "add", "."]);
    await exec("git", ["-C", src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1"]);

    const repo = "acme/outage";
    seedPublishedRepo(repo);
    const dead = {
      name: "p",
      async invoke() {
        return { ok: false as const, kind: "spawn" as const, error: "provider is down" };
      },
    };
    const cfg = mapConfig(parseKdl(['provider "p" { command "p" }', "defaults {", '  primary "p"', "}"].join("\n")));

    const r = await analyzeRepo(repo, { db, providers: { p: dead }, cfg, cloneUrlOverride: src });

    // Zero errors from a discovery whose every batch failed is a processing
    // failure, not a repo without errors — publishing it would retire the
    // repo's whole page set on a provider outage.
    expect(r.failed).toContain("every candidate batch failed");
    expect(errorsForRepo(db, repo).map((x) => x.slug)).toEqual(["v1-err"]);
    expect(getRepo(db, repo)?.analyzedSha).toBe(V1_SHA);
    disposeRepo(src);
    close();
  }, 60_000);
});
