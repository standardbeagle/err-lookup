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

  it("drops a record only after three consecutive analyses miss it", () => {
    seedPublishedRepo("golang/go");

    for (const sha of ["c".repeat(40), "d".repeat(40)]) {
      integrateAnalyzedVersion(db, "golang/go", sha, [errorRow("golang/go", sha, "live")]);
      expect(errorsForRepo(db, "golang/go").map((r) => r.slug).sort()).toEqual(["live", "v1-err"]);
    }
    expect(errorsForRepo(db, "golang/go").find((r) => r.slug === "v1-err")!.missedRuns).toBe(2);

    integrateAnalyzedVersion(db, "golang/go", "e".repeat(40), [errorRow("golang/go", "e".repeat(40), "live")]);

    expect(errorsForRepo(db, "golang/go").map((r) => r.slug)).toEqual(["live"]);
    expect(getRepo(db, "golang/go")?.errorCount).toBe(1);
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
    // discovery batch looks exactly like a repo with no errors — so the
    // published page set survives it and only retires after three.
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
