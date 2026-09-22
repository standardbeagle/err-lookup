import { describe, it, expect } from "vitest";
import { CANONICAL_FAMILIES } from "@errlookup/schema";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { tagVocabulary, promptFamilies } from "../src/phase/tag-vocabulary.js";
import { planTagBackfill, applyTagBackfill } from "../src/phase/tag-backfill.js";
import { storePageDecisions, taxonomyVersion } from "../src/phase/tag-classify.js";
import { errorRow } from "./error-row.js";
import { tmpDbPath } from "./setup.js";

type TestDb = ReturnType<typeof openDb>["db"];

function withDb(name: string, fn: (db: TestDb) => void) {
  return () => {
    const { db, raw } = openDb(tmpDbPath(name));
    try {
      fn(db);
    } finally {
      raw.close();
    }
  };
}

/**
 * Seed `count` pages proposed as `proposal`, currently publishing `current`,
 * each decided by the model as `choice` at `confidence`.
 */
function pages(
  db: TestDb,
  opts: { count: number; proposal?: string | null; current?: string | null; choice?: string | null; confidence?: number; repo?: string; decide?: boolean }
): void {
  const ids: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const row = errorRow({
      repo: opts.repo ?? `org/r${i % 3}`,
      backgroundTagRaw: opts.proposal ?? null,
      backgroundTag: opts.current ?? null,
    });
    db.insert(errors).values(row).run();
    ids.push(row.id);
  }
  if (opts.decide === false) return;
  storePageDecisions(
    db,
    taxonomyVersion(),
    ids.map((errorId) => ({
      errorId,
      choice: opts.choice ?? null,
      method: "model" as const,
      confidence: opts.confidence ?? 0.9,
      runnerUp: null,
      model: "jev-1.13.0",
    }))
  );
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

describe("tagVocabulary", () => {
  it(
    "counts the families the records publish, largest first, with their article",
    withDb("vocab", (db) => {
      pages(db, { count: 5, current: "missing-env-var", decide: false });
      pages(db, { count: 2, current: "file-not-found", decide: false });
      article(db, "missing-env-var", "tag:missing-env-var");
      expect(tagVocabulary(db)[0]).toEqual({ tag: "missing-env-var", errorCount: 5, repoCount: 3, infoSlug: "missing-env-var" });
    })
  );

  it("offers the whole declared taxonomy to the prompt", () => {
    expect(promptFamilies()).toEqual(CANONICAL_FAMILIES.map((f) => f.tag));
  });
});

describe("tag backfill", () => {
  it(
    "plans page transitions from the decisions without writing anything",
    withDb("plan", (db) => {
      pages(db, { count: 6, proposal: "environment-variable-missing", current: "environment-variable-missing", choice: "missing-env-var" });
      pages(db, { count: 4, proposal: "missing-env-var", current: "missing-env-var", choice: "missing-env-var" });
      const plan = planTagBackfill(db);
      expect(plan.transitions).toEqual([{ from: "environment-variable-missing", to: "missing-env-var", pages: 6 }]);
      expect(plan).toMatchObject({ recordsAffected: 6, recordsUnassigned: 0, familiesBefore: 2, familiesAfter: 1, undecided: 0 });
      expect(tagVocabulary(db)).toHaveLength(2);
    })
  );

  it(
    "applies the plan and is idempotent",
    withDb("apply", (db) => {
      pages(db, { count: 6, proposal: "environment-variable-missing", current: "environment-variable-missing", choice: "missing-env-var" });
      expect(applyTagBackfill(db, planTagBackfill(db)).recordsRewritten).toBe(6);
      expect(tagVocabulary(db).map((f) => [f.tag, f.errorCount])).toEqual([["missing-env-var", 6]]);
      const again = planTagBackfill(db);
      expect(again.recordsAffected).toBe(0);
      expect(applyTagBackfill(db, again).recordsRewritten).toBe(0);
    })
  );

  it(
    "takes the family away from pages the model could not place, and says how many",
    withDb("unassign", (db) => {
      pages(db, { count: 3, current: "bgp-session-flapping", choice: "connection-reset", confidence: 0.3 });
      const plan = planTagBackfill(db);
      expect(plan.recordsUnassigned).toBe(3);
      applyTagBackfill(db, plan);
      expect(tagVocabulary(db)).toEqual([]);
    })
  );

  it(
    "re-reads the decisions at another gate for free",
    withDb("gate", (db) => {
      pages(db, { count: 3, current: null, choice: "connection-reset", confidence: 0.5 });
      expect(planTagBackfill(db, 0.55).recordsAffected).toBe(0);
      expect(planTagBackfill(db, 0.45).transitions).toEqual([{ from: null, to: "connection-reset", pages: 3 }]);
    })
  );

  it(
    "leaves undecided pages as they are and counts them",
    withDb("undecided", (db) => {
      pages(db, { count: 4, current: "bgp-session-flapping", decide: false });
      const plan = planTagBackfill(db);
      expect(plan.undecided).toBe(4);
      expect(plan.recordsAffected).toBe(0);
    })
  );

  it(
    "moves an article to the family most of its pages land in",
    withDb("article-move", (db) => {
      pages(db, { count: 7, proposal: "env-var-unset", current: "env-var-unset", choice: "missing-env-var" });
      pages(db, { count: 3, proposal: "env-var-unset", current: "env-var-unset", choice: "missing-required-config" });
      article(db, "env-var-unset", "tag:env-var-unset");
      const plan = planTagBackfill(db);
      expect(plan.infoPageMoves).toEqual([
        { slug: "env-var-unset", from: "tag:env-var-unset", to: "tag:missing-env-var", share: 0.7 },
      ]);
      expect(applyTagBackfill(db, plan).pagesMoved).toBe(1);
    })
  );

  it(
    "holds an article whose pages split, rather than filing most of them wrong",
    withDb("article-split", (db) => {
      pages(db, { count: 5, proposal: "upstream-api-error", choice: "http-error-response" });
      pages(db, { count: 5, proposal: "upstream-api-error", choice: "unexpected-response-shape" });
      article(db, "upstream-api-error", "tag:upstream-api-error");
      const plan = planTagBackfill(db);
      expect(plan.infoPageMoves).toEqual([]);
      expect(plan.infoPageHolds[0]).toMatchObject({ slug: "upstream-api-error", reason: expect.stringContaining("split") });
    })
  );

  it(
    "reports two articles on one family instead of choosing between them",
    withDb("article-conflict", (db) => {
      pages(db, { count: 6, proposal: "env-var-unset", choice: "missing-env-var" });
      article(db, "env-var-unset", "tag:env-var-unset");
      article(db, "missing-env-var", "tag:missing-env-var");
      const res = applyTagBackfill(db, planTagBackfill(db));
      expect(res.pagesMoved).toBe(0);
      expect(res.conflicts.map((c) => [c.slug, c.conflictsWith])).toEqual([["env-var-unset", "missing-env-var"]]);
      expect(db.select().from(infoPages).all()).toHaveLength(2);
    })
  );

  it(
    "leaves an article on a declared family where it is",
    withDb("article-declared", (db) => {
      pages(db, { count: 6, proposal: "missing-env-var", choice: "missing-required-config" });
      article(db, "missing-env-var", "tag:missing-env-var");
      const plan = planTagBackfill(db);
      expect(plan.infoPageMoves).toEqual([]);
      expect(plan.infoPageHolds).toEqual([]);
    })
  );
});
