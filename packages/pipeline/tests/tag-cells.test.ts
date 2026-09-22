import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { buildCells, sampleCell, cellEvidence } from "../src/phase/tag-cells.js";
import { errorRow } from "./error-row.js";
import { tmpDbPath } from "./setup.js";

type TestDb = ReturnType<typeof openDb>["db"];

function seed(db: TestDb, proposal: string, count: number, message = `boom about ${proposal}`, repos = 1) {
  for (let i = 0; i < count; i++) {
    db.insert(errors)
      .values(errorRow({ repo: `org/repo-${i % repos}`, errorMessage: message, errorClass: "ValueError", backgroundTagRaw: proposal }))
      .run();
  }
}

function withDb(fn: (db: TestDb) => void) {
  const { db, raw } = openDb(tmpDbPath("cells"));
  try {
    fn(db);
  } finally {
    raw.close();
  }
}

describe("buildCells", () => {
  it("pools every spelling of one mode and object into one candidate", () => {
    withDb((db) => {
      seed(db, "missing-env-var", 60);
      seed(db, "environment-variable-missing", 30);
      seed(db, "missing-config-key", 20);
      const { cells } = buildCells(db, { minErrors: 10 });
      expect(cells).toHaveLength(1);
      expect(cells[0]).toMatchObject({ key: "absent×config", errorCount: 110 });
      expect(cells[0]!.members.map((m) => m.proposal)).toEqual([
        "missing-env-var",
        "environment-variable-missing",
        "missing-config-key",
      ]);
      // The current family the spellings already fold onto, for the reviewer.
      expect(cells[0]!.incumbents[0]).toEqual({ family: "missing-env-var", errorCount: 90 });
    });
  });

  it("splits a heavy subject out of a broad cell", () => {
    withDb((db) => {
      seed(db, "invalid-url-format", 50);
      seed(db, "invalid-date-format", 20);
      seed(db, "invalid-regex-pattern", 15);
      const { cells } = buildCells(db, { minErrors: 10, splitMin: 40 });
      expect(cells.map((c) => [c.key, c.errorCount])).toEqual([
        ["invalid×format:url", 50],
        ["invalid×format", 35],
      ]);
    });
  });

  it("does not split a subject that is the whole cell", () => {
    withDb((db) => {
      seed(db, "invalid-url-format", 50);
      seed(db, "malformed-url", 5);
      const { cells } = buildCells(db, { minErrors: 10, splitMin: 40 });
      expect(cells.map((c) => c.key)).toEqual(["invalid×format"]);
    });
  });

  it("reports what no cell can hold instead of inventing one", () => {
    withDb((db) => {
      seed(db, "missing-env-var", 60);
      seed(db, "bgp-session-flapping", 7); // parses to nothing
      seed(db, "missing-dependency", 3); // parses, but under the floor
      const build = buildCells(db, { minErrors: 10 });
      expect(build.cells.map((c) => c.key)).toEqual(["absent×config"]);
      expect(build.uncelledErrors).toBe(10);
      expect(build.totalErrors).toBe(70);
    });
  });

  it("names the articles written for the cell's proposals", () => {
    withDb((db) => {
      seed(db, "missing-env-var", 60);
      db.insert(infoPages)
        .values({
          slug: "missing-env-var",
          clusterKey: "tag:missing-env-var",
          title: "t",
          summary: "s",
          background: "b",
          commonCauses: [],
          fixes: [],
          guideSlugs: [],
          errorIds: [],
          errorCount: 60,
          repoCount: 1,
          generatedAt: "2026-09-05T00:00:00Z",
        })
        .run();
      expect(buildCells(db, { minErrors: 10 }).cells[0]!.articles).toEqual([
        { slug: "missing-env-var", proposal: "missing-env-var" },
      ]);
    });
  });
});

describe("cell evidence", () => {
  it("samples one page per library", () => {
    withDb((db) => {
      seed(db, "missing-env-var", 40, "FOO is required", 4);
      const cell = buildCells(db, { minErrors: 10 }).cells[0]!;
      const samples = sampleCell(db, cell, 10);
      expect(samples).toHaveLength(4);
      expect(new Set(samples.map((s) => s.repo)).size).toBe(4);
    });
  });

  it("measures how often the messages state the cell's own mode", () => {
    withDb((db) => {
      seed(db, "missing-env-var", 30, "FOO is required");
      seed(db, "env-var-missing", 10, "FOO must be between 1 and 5");
      const cell = buildCells(db, { minErrors: 10 }).cells[0]!;
      const e = cellEvidence(db, cell);
      expect(e.pages).toBe(40);
      expect(e.messageAgrees).toBeCloseTo(0.75, 5);
      expect(e.messageDisagrees).toBeCloseTo(0.25, 5);
      expect(e.classes[0]).toEqual({ value: "ValueError", count: 40 });
    });
  });
});
