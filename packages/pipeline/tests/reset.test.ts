import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, type Db } from "../src/db/client.js";
import {
  upsertRepo,
  recordPhase,
  replaceErrors,
  resetRepo,
  reposByStatus,
  purgeOrphanedJobs,
  latestPhaseRun,
  errorsForRepo,
} from "../src/db/store.js";

const dbPath = resolve(".tmp-test", `reset-${process.pid}.db`);
let db: Db;
let close: () => void;

function seedRepo(repo: string, status: "analyzed" | "failed" | "analyzing", sha = "abc12345") {
  upsertRepo(db, { repo, status, analyzedSha: sha, analyzedAt: "2026-08-01T00:00:00.000Z", errorCount: 1 });
  recordPhase(db, {
    repo,
    phase: "discovery",
    status: "success",
    startedAt: 1,
    completedAt: 2,
    analyzedSha: sha,
    result: "[]",
  });
  replaceErrors(db, repo, [
    {
      id: `${repo.replace(/\W/g, "").slice(0, 16).padEnd(16, "0")}`,
      repo,
      slug: "boom",
      errorCode: "E_BOOM",
      errorMessage: "boom",
      messagePattern: "boom",
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
    },
  ]);
}

beforeEach(() => {
  rmSync(dbPath, { force: true });
  const opened = openDb(dbPath);
  db = opened.db;
  close = () => opened.raw.close();
});

describe("resetRepo", () => {
  it("returns a failed repo to pending and clears its analysis", () => {
    seedRepo("golang/go", "failed");
    upsertRepo(db, { repo: "golang/go", lastError: "discovery: [spawn] claude exited 1" });

    const summary = resetRepo(db, "golang/go");
    expect(summary.errorsDeleted).toBe(1);
    expect(summary.jobsDeleted).toBe(1);

    const row = reposByStatus(db, "pending").find((r) => r.repo === "golang/go");
    expect(row).toBeTruthy();
    expect(row!.lastError).toBeNull();
    expect(row!.analyzedSha).toBeNull();
    expect(row!.analyzedAt).toBeNull();
    expect(row!.errorCount).toBe(0);
    close();
  });

  it("clears phase history so the work is actually redone, not just relabelled", () => {
    seedRepo("golang/go", "failed");
    expect(latestPhaseRun(db, "golang/go", "abc12345", "discovery")?.status).toBe("success");

    resetRepo(db, "golang/go");

    // A surviving success row would make resume skip discovery forever.
    expect(latestPhaseRun(db, "golang/go", "abc12345", "discovery")).toBeUndefined();
    expect(errorsForRepo(db, "golang/go")).toHaveLength(0);
    close();
  });

  it("leaves other repos untouched", () => {
    seedRepo("golang/go", "failed");
    seedRepo("axios/axios", "analyzed");

    resetRepo(db, "golang/go");

    expect(errorsForRepo(db, "axios/axios")).toHaveLength(1);
    expect(latestPhaseRun(db, "axios/axios", "abc12345", "discovery")?.status).toBe("success");
    expect(reposByStatus(db, "analyzed").map((r) => r.repo)).toEqual(["axios/axios"]);
    close();
  });
});

describe("purgeOrphanedJobs", () => {
  it("drops running rows left by crashed runs but spares live ones", () => {
    for (const repo of ["golang/go", "vercel/next.js"]) {
      upsertRepo(db, { repo, status: repo === "golang/go" ? "failed" : "analyzing" });
      recordPhase(db, { repo, phase: "discovery", status: "running", startedAt: 1, analyzedSha: "deadbeef" });
    }

    // vercel/next.js is mid-analysis: its running row is real, not residue.
    const purged = purgeOrphanedJobs(db, new Set(["vercel/next.js"]));

    expect(purged).toBe(1);
    expect(latestPhaseRun(db, "golang/go", "deadbeef", "discovery")).toBeUndefined();
    expect(latestPhaseRun(db, "vercel/next.js", "deadbeef", "discovery")?.status).toBe("running");
    close();
  });
});

describe("latestPhaseRun tie-breaking", () => {
  it("prefers the terminal row when it shares startedAt with the running row", () => {
    // Discovery records both rows with the same startedAt. Ordering on that
    // column alone leaves the pair tied, and resolving the tie to `running`
    // makes resume re-run a phase that already succeeded.
    const started = 1_700_000_000_000;
    upsertRepo(db, { repo: "gohugoio/hugo", status: "analyzed" });
    recordPhase(db, { repo: "gohugoio/hugo", phase: "discovery", status: "running", startedAt: started, analyzedSha: "cafe1234" });
    recordPhase(db, {
      repo: "gohugoio/hugo",
      phase: "discovery",
      status: "success",
      startedAt: started,
      completedAt: started + 1000,
      analyzedSha: "cafe1234",
      result: '[{"message":"x"}]',
    });

    const run = latestPhaseRun(db, "gohugoio/hugo", "cafe1234", "discovery");
    expect(run?.status).toBe("success");
    expect(run?.result).toContain("message");
    close();
  });

  it("still reports a genuinely unfinished phase as running", () => {
    upsertRepo(db, { repo: "gohugoio/hugo", status: "analyzing" });
    recordPhase(db, { repo: "gohugoio/hugo", phase: "discovery", status: "running", startedAt: 5, analyzedSha: "cafe1234" });
    expect(latestPhaseRun(db, "gohugoio/hugo", "cafe1234", "discovery")?.status).toBe("running");
    close();
  });
});
