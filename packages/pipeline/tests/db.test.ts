import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/client.js";
import { repositories, errors, jobHistory } from "../src/db/schema.js";
import { tmpDbPath } from "./setup.js";

describe("sqlite working db", () => {
  it("opens with WAL mode and runs migrations", () => {
    const path = tmpDbPath("wal");
    const { db, raw } = openDb(path);
    const mode = raw.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    // migrations created the tables
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("repositories");
    expect(names).toContain("errors");
    expect(names).toContain("job_history");
    expect(names).toContain("queue");
    raw.close();
  });

  it("round-trips a repository row", () => {
    const path = tmpDbPath("repo-rt");
    const { db, raw } = openDb(path);
    db.insert(repositories)
      .values({
        repo: "sindresorhus/is",
        description: "Type check values",
        language: "TypeScript",
        stars: 1000,
        defaultBranch: "main",
        analyzedSha: "a".repeat(40),
        analyzedAt: "2026-07-14T00:00:00Z",
        errorCount: 0,
        status: "analyzed",
      })
      .run();
    const rows = db.select().from(repositories).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo).toBe("sindresorhus/is");
    expect(rows[0]!.status).toBe("analyzed");
    raw.close();
  });

  it("round-trips an error row with JSON arrays", () => {
    const path = tmpDbPath("err-rt");
    const { db, raw } = openDb(path);
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
        githubUrl: "https://github.com/axios/axios/blob/abc/lib/core/settle.js#L18",
        solutions: ["fix1", "fix2"],
        preventionTips: ["tip1"],
        tags: ["http", "network"],
        analyzedSha: "b".repeat(40),
        analyzedAt: "2026-07-14T00:00:00Z",
        schemaVersion: 2,
      })
      .run();

    const rows = db.select().from(errors).where(eq(errors.repo, "axios/axios")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.solutions).toEqual(["fix1", "fix2"]);
    expect(rows[0]!.tags).toEqual(["http", "network"]);
    raw.close();
  });

  it("enforces unique (repo, slug) on errors", () => {
    const path = tmpDbPath("uniq");
    const { db, raw } = openDb(path);
    const base = {
      id: "id1",
      repo: "r/r",
      slug: "dup",
      errorMessage: "m",
      messagePattern: "m",
      errorType: "exception",
      severity: "error",
      filePath: "f.ts",
      githubUrl: "u",
      analyzedSha: "c".repeat(40),
      analyzedAt: "2026-07-14T00:00:00Z",
    };
    db.insert(errors).values(base).run();
    expect(() =>
      db
        .insert(errors)
        .values({ ...base, id: "id2" })
        .run()
    ).toThrow();
    raw.close();
  });

  it("round-trips a job_history row", () => {
    const path = tmpDbPath("job");
    const { db, raw } = openDb(path);
    db.insert(jobHistory)
      .values({
        repo: "r/r",
        phase: "discovery",
        status: "success",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      })
      .run();
    const rows = db.select().from(jobHistory).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe("discovery");
    raw.close();
  });
});

describe("phase batch checkpoints", () => {
  it("round-trips a batch result and scopes it to repo+sha+phase", async () => {
    const { phaseBatchCheckpoint } = await import("../src/db/checkpoints.js");
    const { db, raw } = openDb(tmpDbPath("ckpt-rt"));
    const ckpt = phaseBatchCheckpoint(db, "o/r", "sha1", "discovery");
    expect(ckpt.get("k1")).toBeNull();
    ckpt.put("k1", '{"errors":[]}');
    expect(ckpt.get("k1")).toBe('{"errors":[]}');
    // a different phase at the same key sees nothing
    expect(phaseBatchCheckpoint(db, "o/r", "sha1", "analysis").get("k1")).toBeNull();
    // put is an upsert — a resumed batch may legitimately re-complete
    ckpt.put("k1", '{"errors":[1]}');
    expect(ckpt.get("k1")).toBe('{"errors":[1]}');
    raw.close();
  });

  it("drops stale other-sha rows when a checkpoint opens, and clears on demand", async () => {
    const { phaseBatchCheckpoint, clearPhaseBatches } = await import("../src/db/checkpoints.js");
    const { db, raw } = openDb(tmpDbPath("ckpt-stale"));
    phaseBatchCheckpoint(db, "o/r", "old-sha", "discovery").put("k1", "old");
    // HEAD moved: opening at the new sha reaps the old sha's rows
    const fresh = phaseBatchCheckpoint(db, "o/r", "new-sha", "discovery");
    expect(fresh.get("k1")).toBeNull();
    const count = () =>
      (raw.prepare("SELECT count(*) c FROM phase_batches").get() as { c: number }).c;
    expect(count()).toBe(0);
    fresh.put("k2", "v");
    expect(count()).toBe(1);
    clearPhaseBatches(db, "o/r", "discovery");
    expect(count()).toBe(0);
    raw.close();
  });
});
