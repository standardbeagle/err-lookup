import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { tagVocabulary, promptFamilies, tagIndexFor } from "../src/phase/tag-vocabulary.js";
import { planTagBackfill, applyTagBackfill } from "../src/phase/tag-backfill.js";
import { resolveTag } from "@errlookup/schema";
import { tmpDbPath } from "./setup.js";

let idSeq = 0;
function row(repo: string, backgroundTag: string | null) {
  const n = idSeq++;
  return {
    id: n.toString(16).padStart(16, "0"),
    repo,
    slug: `boom-${n}`,
    errorCode: null,
    errorMessage: `boom ${n}`,
    messagePattern: `boom ${n}`,
    errorType: "exception",
    errorClass: null,
    httpStatus: null,
    severity: "error",
    filePath: "src/a.js",
    lineNumber: 1,
    sourceCode: null,
    sourceCodeStart: null,
    sourceCodeEnd: null,
    githubUrl: "https://github.com/a/b/blob/x/src/a.js#L1",
    documentation: "d",
    triggerScenarios: "t",
    commonSituations: "",
    solutions: ["s"],
    exampleFix: null,
    handlingStrategy: null,
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: [],
    tags: [],
    backgroundTag,
    analyzedSha: "a".repeat(40),
    analyzedAt: "2026-08-11T00:00:00Z",
    schemaVersion: 2,
  };
}

function seed(db: ReturnType<typeof openDb>["db"], repo: string, tag: string | null, count: number) {
  for (let i = 0; i < count; i++) db.insert(errors).values(row(repo, tag)).run();
}

function fixture() {
  const { db, raw } = openDb(tmpDbPath());
  seed(db, "a/one", "missing-env-var", 30);
  seed(db, "b/two", "missing-env-var", 10);
  seed(db, "a/one", "environment-variable-missing", 6);
  seed(db, "c/three", "missing-environment-variables", 4);
  seed(db, "a/one", "bgp-session-flapping", 9);
  seed(db, "a/one", null, 5);
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
      errorCount: 40,
      repoCount: 2,
      generatedAt: "2026-09-05T00:00:00Z",
    })
    .run();
  return { db, raw };
}

describe("tagVocabulary", () => {
  it("counts records and repos per family, largest first, and names the covering article", () => {
    const { db, raw } = fixture();
    try {
      const v = tagVocabulary(db);
      expect(v[0]).toEqual({ tag: "missing-env-var", errorCount: 40, repoCount: 2, infoSlug: "missing-env-var" });
      expect(v.find((f) => f.tag === "bgp-session-flapping")).toEqual({
        tag: "bgp-session-flapping",
        errorCount: 9,
        repoCount: 1,
        infoSlug: null,
      });
      // Untagged records are not a family.
      expect(v.some((f) => f.tag === null || f.tag === "")).toBe(false);
    } finally {
      raw.close();
    }
  });

  it("the prompt shortlist holds only established families", () => {
    const { db, raw } = fixture();
    try {
      const families = promptFamilies(db);
      expect(families).toContain("missing-env-var");
      expect(families).toContain("bgp-session-flapping");
      // 4 records is below the floor a family must clear to be offered.
      expect(families).not.toContain("missing-environment-variables");
    } finally {
      raw.close();
    }
  });

  it("the write-path index folds a variant onto the biggest spelling", () => {
    const { db, raw } = fixture();
    try {
      const index = tagIndexFor(db);
      expect(resolveTag("Environment Variable Missing", index)).toBe("missing-env-var");
      expect(resolveTag("bgp-session-flapping", index)).toBe("bgp-session-flapping");
    } finally {
      raw.close();
    }
  });
});

describe("tag backfill", () => {
  it("plans the merges without touching the database", () => {
    const { db, raw } = fixture();
    try {
      const plan = planTagBackfill(db);
      expect(plan.familiesBefore).toBe(4);
      expect(plan.familiesAfter).toBe(2);
      expect(plan.recordsAffected).toBe(10);
      expect(plan.merges.map((m) => [m.from, m.to])).toEqual([
        ["environment-variable-missing", "missing-env-var"],
        ["missing-environment-variables", "missing-env-var"],
      ]);
      // Dry run: nothing moved.
      expect(tagVocabulary(db).length).toBe(4);
    } finally {
      raw.close();
    }
  });

  it("applying it moves the records onto the covered family", () => {
    const { db, raw } = fixture();
    try {
      const rewritten = applyTagBackfill(db, planTagBackfill(db));
      expect(rewritten).toBe(10);
      const v = tagVocabulary(db);
      expect(v.map((f) => f.tag).sort()).toEqual(["bgp-session-flapping", "missing-env-var"]);
      expect(v.find((f) => f.tag === "missing-env-var")!.errorCount).toBe(50);
      expect(v.find((f) => f.tag === "missing-env-var")!.repoCount).toBe(3);
    } finally {
      raw.close();
    }
  });

  it("is idempotent — a second pass finds nothing to do", () => {
    const { db, raw } = fixture();
    try {
      applyTagBackfill(db, planTagBackfill(db));
      const second = planTagBackfill(db);
      expect(second.merges).toEqual([]);
      expect(second.recordsAffected).toBe(0);
      expect(applyTagBackfill(db, second)).toBe(0);
    } finally {
      raw.close();
    }
  });
});
