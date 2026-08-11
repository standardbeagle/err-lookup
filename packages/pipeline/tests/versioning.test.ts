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

  it("integrating a complete new version replaces records and pointer together", () => {
    seedPublishedRepo("golang/go");

    integrateAnalyzedVersion(db, "golang/go", V2_SHA, [
      errorRow("golang/go", V2_SHA, "v2-err-1"),
      errorRow("golang/go", V2_SHA, "v2-err-2"),
    ]);

    const row = getRepo(db, "golang/go")!;
    expect(row.status).toBe("analyzed");
    expect(row.analyzedSha).toBe(V2_SHA);
    expect(row.errorCount).toBe(2);
    expect(row.lastError).toBeNull();
    const records = errorsForRepo(db, "golang/go");
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.analyzedSha === V2_SHA)).toBe(true);
    close();
  });

  it("integrating an empty result is a valid published version", () => {
    seedPublishedRepo("clean/repo");

    integrateAnalyzedVersion(db, "clean/repo", V2_SHA, []);

    const row = getRepo(db, "clean/repo")!;
    expect(row.status).toBe("analyzed");
    expect(row.analyzedSha).toBe(V2_SHA);
    expect(row.errorCount).toBe(0);
    expect(errorsForRepo(db, "clean/repo")).toHaveLength(0);
    close();
  });
});
