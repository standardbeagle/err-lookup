import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, infoPages, tagDecisions } from "../src/db/schema.js";
import { tagVocabulary, promptFamilies } from "../src/phase/tag-vocabulary.js";
import { planTagBackfill, applyTagBackfill } from "../src/phase/tag-backfill.js";
import { CANONICAL_FAMILIES } from "@errlookup/schema";
import { tmpDbPath } from "./setup.js";

let idSeq = 0;
function row(repo: string, proposal: string | null, family: string | null) {
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
    backgroundTag: family,
    backgroundTagRaw: proposal,
    analyzedSha: "a".repeat(40),
    analyzedAt: "2026-08-11T00:00:00Z",
    schemaVersion: 2,
  };
}

type TestDb = ReturnType<typeof openDb>["db"];

/** `count` records whose proposal is `proposal` and which currently publish `family`. */
function seed(db: TestDb, repo: string, proposal: string | null, family: string | null, count: number) {
  for (let i = 0; i < count; i++) db.insert(errors).values(row(repo, proposal, family)).run();
}

function decide(db: TestDb, proposal: string, canonical: string | null) {
  db.insert(tagDecisions)
    .values({
      proposal,
      canonical,
      method: "model",
      confidence: 0.9,
      runnerUp: null,
      model: "jev-1.13.0",
      decidedAt: "2026-09-22T00:00:00Z",
    })
    .run();
}

function article(db: TestDb, slug: string, clusterKey: string) {
  db.insert(infoPages)
    .values({
      slug,
      clusterKey,
      title: "t",
      summary: "s",
      background: "b",
      commonCauses: [],
      fixes: [],
      guideSlugs: [],
      errorIds: [],
      errorCount: 6,
      repoCount: 1,
      generatedAt: "2026-09-05T00:00:00Z",
    })
    .run();
}

/**
 * A corpus mid-migration: 40 records already published under the declared
 * family, 10 still carrying proposals that name it differently, 9 under a
 * proposal nothing covers, and 5 with no family at all.
 */
function fixture() {
  const { db, raw } = openDb(tmpDbPath());
  seed(db, "a/one", "missing-env-var", "missing-env-var", 30);
  seed(db, "b/two", "missing-env-var", "missing-env-var", 10);
  seed(db, "a/one", "environment-variable-missing", null, 6);
  seed(db, "c/three", "missing-environment-variables", null, 4);
  seed(db, "a/one", "bgp-session-flapping", null, 9);
  seed(db, "a/one", null, null, 5);
  decide(db, "missing-env-var", "missing-env-var");
  decide(db, "environment-variable-missing", "missing-env-var");
  decide(db, "missing-environment-variables", "missing-env-var");
  decide(db, "bgp-session-flapping", null);
  article(db, "missing-env-var", "tag:missing-env-var");
  return { db, raw };
}

describe("tagVocabulary", () => {
  it("counts the families the records actually publish, largest first", () => {
    const { db, raw } = fixture();
    try {
      const v = tagVocabulary(db);
      expect(v[0]).toEqual({
        tag: "missing-env-var",
        errorCount: 40,
        repoCount: 2,
        infoSlug: "missing-env-var",
      });
      // A proposal is not a family until a decision puts it in one.
      expect(v.some((f) => f.tag === "bgp-session-flapping")).toBe(false);
      expect(v.some((f) => f.tag === null || f.tag === "")).toBe(false);
    } finally {
      raw.close();
    }
  });

  it("offers the whole declared taxonomy to the prompt, not the corpus's habits", () => {
    // Suggesting a name is what makes it fold for free, so every declared
    // family is worth suggesting — including ones the corpus has never used.
    const families = promptFamilies();
    expect(families).toEqual(CANONICAL_FAMILIES.map((f) => f.tag));
    expect(families).toContain("missing-env-var");
    expect(families).not.toContain("bgp-session-flapping");
  });
});

describe("tag backfill", () => {
  it("plans from the decisions without touching the database", () => {
    const { db, raw } = fixture();
    try {
      const plan = planTagBackfill(db);
      expect(plan.merges.map((m) => [m.from, m.to])).toEqual([
        ["environment-variable-missing", "missing-env-var"],
        ["missing-environment-variables", "missing-env-var"],
      ]);
      expect(plan.recordsAffected).toBe(10);
      expect(plan.recordsUnassigned).toBe(0);
      expect(plan.familiesBefore).toBe(1);
      expect(plan.familiesAfter).toBe(1);
      expect(tagVocabulary(db)[0]!.errorCount).toBe(40);
    } finally {
      raw.close();
    }
  });

  it("applying it moves the records onto the declared family", () => {
    const { db, raw } = fixture();
    try {
      const res = applyTagBackfill(db, planTagBackfill(db));
      expect(res.recordsRewritten).toBe(10);
      const v = tagVocabulary(db);
      expect(v.map((f) => f.tag)).toEqual(["missing-env-var"]);
      expect(v[0]!.errorCount).toBe(50);
      expect(v[0]!.repoCount).toBe(3);
    } finally {
      raw.close();
    }
  });

  it("takes a family away from records the taxonomy has no home for", () => {
    // The published families are exactly the declared ones. A record whose
    // proposal fits nothing carries no family rather than inventing one, and
    // the plan says how many records that costs before anything is written.
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", "bgp-session-flapping", 9);
      decide(db, "bgp-session-flapping", null);

      const plan = planTagBackfill(db);
      expect(plan.recordsUnassigned).toBe(9);
      expect(plan.merges).toEqual([
        { from: "bgp-session-flapping", current: "bgp-session-flapping", to: null, errorCount: 9 },
      ]);
      applyTagBackfill(db, plan);
      expect(tagVocabulary(db)).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("says nothing about proposals nobody has ruled on", () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", "bgp-session-flapping", 9);

      const plan = planTagBackfill(db);
      expect(plan.merges).toEqual([]);
      expect(plan.undecidedProposals).toBe(1);
      expect(plan.undecidedRecords).toBe(9);
      // Undecided records keep what they carry — the backfill has no opinion,
      // and guessing one is the behaviour the taxonomy replaced.
      expect(applyTagBackfill(db, plan).recordsRewritten).toBe(0);
      expect(tagVocabulary(db)[0]!.tag).toBe("bgp-session-flapping");
    } finally {
      raw.close();
    }
  });

  it("carries an article onto the family its records moved to", () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "missing-env-var", "missing-env-var", 30);
      seed(db, "a/one", "environment-variable-missing", null, 6);
      decide(db, "environment-variable-missing", "missing-env-var");
      article(db, "environment-variable-missing", "tag:environment-variable-missing");

      const plan = planTagBackfill(db);
      expect(plan.infoPageMoves).toEqual([
        {
          slug: "environment-variable-missing",
          from: "tag:environment-variable-missing",
          to: "tag:missing-env-var",
        },
      ]);
      const res = applyTagBackfill(db, plan);
      expect(res.pagesMoved).toBe(1);
      expect(res.conflicts).toEqual([]);
      expect(tagVocabulary(db)[0]!.infoSlug).toBe("environment-variable-missing");
    } finally {
      raw.close();
    }
  });

  it("leaves both articles alone when two now describe one family", () => {
    const { db, raw } = fixture(); // already carries an article on missing-env-var
    try {
      article(db, "environment-variable-missing", "tag:environment-variable-missing");

      const res = applyTagBackfill(db, planTagBackfill(db));
      expect(res.pagesMoved).toBe(0);
      expect(res.conflicts.map((c) => [c.slug, c.conflictsWith])).toEqual([
        ["environment-variable-missing", "missing-env-var"],
      ]);
      // Nothing was deleted: which article survives is an editorial call.
      expect(db.select().from(infoPages).all()).toHaveLength(2);
    } finally {
      raw.close();
    }
  });

  it("repairs an article stranded by an earlier fold", () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      // The records already moved in a previous pass; the article did not, and
      // its family has no records left to put it back in the vocabulary. The
      // decision outlives the records, which is what makes the repair possible.
      seed(db, "a/one", "missing-env-var", "missing-env-var", 30);
      decide(db, "environment-variable-missing", "missing-env-var");
      article(db, "environment-variable-missing", "tag:environment-variable-missing");

      const plan = planTagBackfill(db);
      expect(plan.merges).toEqual([]);
      expect(plan.infoPageMoves).toHaveLength(1);
      const res = applyTagBackfill(db, plan);
      expect(res.recordsRewritten).toBe(0);
      expect(res.pagesMoved).toBe(1);
      expect(tagVocabulary(db)[0]!.infoSlug).toBe("environment-variable-missing");
    } finally {
      raw.close();
    }
  });

  it("leaves an article alone when its family fits nothing in the taxonomy", () => {
    // Clearing the key would hide the article from the collector's coverage
    // check, which would then write a second article on the same cluster.
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", null, 9);
      decide(db, "bgp-session-flapping", null);
      article(db, "bgp-session-flapping", "tag:bgp-session-flapping");

      const plan = planTagBackfill(db);
      expect(plan.infoPageMoves).toEqual([]);
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
      expect(applyTagBackfill(db, second).recordsRewritten).toBe(0);
    } finally {
      raw.close();
    }
  });
});
