import { describe, it, expect } from "vitest";
import { CANONICAL_FAMILIES } from "@errlookup/schema";
import { openDb } from "../src/db/client.js";
import { errors, pageTagDecisions } from "../src/db/schema.js";
import { TypeSafeClient } from "../src/provider/typesafe.js";
import {
  ruleFold,
  ruleDecision,
  taxonomyVersion,
  publishedFamily,
  classifyPendingPages,
  pendingCount,
  pageFamiliesFor,
  unplacedPages,
  storePageDecisions,
  CONFIDENCE_THRESHOLD,
} from "../src/phase/tag-classify.js";
import { NO_FAMILY } from "../src/phase/tag-page.js";
import { errorRow } from "./error-row.js";
import { tmpDbPath } from "./setup.js";

type TestDb = ReturnType<typeof openDb>["db"];

function withDb(name: string, fn: (db: TestDb) => Promise<void> | void) {
  return async () => {
    const { db, raw } = openDb(tmpDbPath(name));
    try {
      await fn(db);
    } finally {
      raw.close();
    }
  };
}

/** A Jev stand-in answering every page with one scripted choice and confidence. */
function jev(choice: string, confidence: number) {
  let calls = 0;
  const fetchImpl = async (_u: unknown, init: RequestInit): Promise<Response> => {
    calls++;
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => [
        k,
        { type: "choice", choice, confidence, probabilities: { [choice]: confidence, [NO_FAMILY]: 1 - confidence } },
      ])
    );
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 5000, output_tokens: 1 } }));
  };
  const client = new TypeSafeClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, calls: () => calls };
}

describe("rules", () => {
  it("folds a proposal by spelling onto a declared family", () => {
    expect(ruleFold("environment-variable-missing")).toBe("missing-env-var");
    expect(ruleFold("bgp-session-flapping")).toBeNull();
  });

  it("settles a page from a precise content signal, and nothing else settles it", () => {
    const page = {
      id: "x",
      repo: "r",
      errorMessage: "boom",
      errorClass: "System.ArgumentNullException",
      errorCode: null,
      httpStatus: null,
      errorType: "exception",
      documentation: null,
      triggerScenarios: null,
      commonSituations: null,
      proposal: "missing-env-var",
    };
    expect(ruleDecision(page)).toEqual({ choice: "null-argument", method: "rule-content" });
    // The proposed name is not a rule on its own: the ablation decides that.
    expect(ruleDecision({ ...page, errorClass: "ValueError" })).toBeNull();
  });
});

describe("taxonomy version", () => {
  it("is stable for one taxonomy and moves with any rubric edit", () => {
    expect(taxonomyVersion()).toBe(taxonomyVersion([...CANONICAL_FAMILIES]));
    const edited = CANONICAL_FAMILIES.map((f, i) => (i === 0 ? { ...f, criteria: `${f.criteria} Edited.` } : f));
    expect(taxonomyVersion(edited)).not.toBe(taxonomyVersion());
  });
});

describe("publishedFamily", () => {
  it("publishes rules as made and model choices only above the gate", () => {
    expect(publishedFamily({ choice: "file-not-found", method: "rule-content", confidence: null })).toBe("file-not-found");
    expect(publishedFamily({ choice: "file-not-found", method: "model", confidence: CONFIDENCE_THRESHOLD })).toBe("file-not-found");
    expect(publishedFamily({ choice: "file-not-found", method: "model", confidence: CONFIDENCE_THRESHOLD - 0.01 })).toBeNull();
    expect(publishedFamily({ choice: null, method: "model", confidence: 0.99 })).toBeNull();
  });

  it("re-reads the same decision at another gate without asking again", () => {
    const d = { choice: "file-not-found", method: "model" as const, confidence: 0.5 };
    expect(publishedFamily(d, 0.55)).toBeNull();
    expect(publishedFamily(d, 0.45)).toBe("file-not-found");
  });
});

describe("classifyPendingPages", () => {
  it(
    "settles by rule for free and asks the model about the rest",
    withDb("classify-pages", async (db) => {
      db.insert(errors).values(errorRow({ errorClass: "FileNotFoundError" })).run();
      for (let i = 0; i < 3; i++) db.insert(errors).values(errorRow({ errorMessage: "peer reset the session" })).run();
      const { client, calls } = jev("connection-reset", 0.8);

      const res = await classifyPendingPages(db, client);

      expect(res).toMatchObject({ byRule: 1, byModel: 3, unplaced: 0 });
      expect(calls()).toBe(1); // three pages packed into one request
      const rows = db.select().from(pageTagDecisions).all();
      expect(rows.map((r) => [r.method, r.choice]).sort()).toEqual([
        ["model", "connection-reset"],
        ["model", "connection-reset"],
        ["model", "connection-reset"],
        ["rule-content", "file-not-found"],
      ]);
      expect(rows.every((r) => r.taxonomyVersion === taxonomyVersion())).toBe(true);
    })
  );

  it(
    "resumes: a decided page is never asked about again",
    withDb("classify-resume", async (db) => {
      for (let i = 0; i < 20; i++) db.insert(errors).values(errorRow()).run();
      await classifyPendingPages(db, jev("connection-reset", 0.8).client, { limit: 8 });
      expect(pendingCount(db, taxonomyVersion())).toBe(12);
      const second = jev("connection-reset", 0.8);
      await classifyPendingPages(db, second.client);
      expect(pendingCount(db, taxonomyVersion())).toBe(0);
      expect(second.calls()).toBe(2); // the 12 left, eight per request
    })
  );

  it(
    "treats a decision against another taxonomy as no decision",
    withDb("classify-version", async (db) => {
      const row = errorRow();
      db.insert(errors).values(row).run();
      storePageDecisions(db, "old-version", [
        { errorId: row.id, choice: "file-not-found", method: "model", confidence: 0.9, runnerUp: null, model: "jev-1.13.0" },
      ]);
      expect(pendingCount(db, taxonomyVersion())).toBe(1);
      await classifyPendingPages(db, jev("connection-reset", 0.8).client);
      expect(pageFamiliesFor(db, [row.id]).get(row.id)).toBe("connection-reset");
    })
  );

  it(
    "counts what it could not place, and leaves it unpublished",
    withDb("classify-unplaced", async (db) => {
      const row = errorRow();
      db.insert(errors).values(row).run();
      const res = await classifyPendingPages(db, jev("connection-reset", 0.3).client);
      expect(res.unplaced).toBe(1);
      expect(pageFamiliesFor(db, [row.id]).get(row.id)).toBeNull();
    })
  );
});

describe("unplacedPages", () => {
  it(
    "groups pages with no family by the name their model proposed, with the nearest choice",
    withDb("unplaced", async (db) => {
      for (let i = 0; i < 3; i++) db.insert(errors).values(errorRow({ backgroundTagRaw: "bgp-session-flapping", repo: `o/r${i}` })).run();
      db.insert(errors).values(errorRow({ backgroundTagRaw: "quantum-decoherence" })).run();
      await classifyPendingPages(db, jev("connection-reset", 0.3).client);

      const groups = unplacedPages(db);
      expect(groups).toEqual([
        { proposal: "bgp-session-flapping", pages: 3, repos: 3, nearest: "connection-reset" },
        { proposal: "quantum-decoherence", pages: 1, repos: 1, nearest: "connection-reset" },
      ]);
    })
  );
});
