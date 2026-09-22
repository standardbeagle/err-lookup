import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, tagDecisions, infoPages } from "../src/db/schema.js";
import {
  ruleFold,
  familyQuestion,
  clusterState,
  classifyCluster,
  pendingProposals,
  classifyPending,
  candidateProposals,
  decisionMap,
  NO_FAMILY,
  CONFIDENCE_THRESHOLD,
} from "../src/phase/tag-classify.js";
import { TypeSafeClient } from "../src/provider/typesafe.js";
import { CANONICAL_FAMILIES } from "@errlookup/schema";
import { tmpDbPath } from "./setup.js";

let idSeq = 0;
function seed(
  db: ReturnType<typeof openDb>["db"],
  repo: string,
  proposal: string,
  message: string,
  count = 1
) {
  for (let i = 0; i < count; i++) {
    const n = idSeq++;
    db.insert(errors)
      .values({
        id: n.toString(16).padStart(16, "0"),
        repo,
        slug: `boom-${n}`,
        errorCode: null,
        errorMessage: message,
        messagePattern: message,
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
        backgroundTag: null,
        backgroundTagRaw: proposal,
        analyzedSha: "a".repeat(40),
        analyzedAt: "2026-08-11T00:00:00Z",
        schemaVersion: 2,
      })
      .run();
  }
}

/** A client whose every answer is scripted, so the gate can be tested exactly. */
function scripted(answers: { choice: string; confidence: number; second?: string }[]) {
  let i = 0;
  const fetchImpl = async (): Promise<Response> => {
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          family: {
            type: "choice",
            choice: a.choice,
            probabilities: { [a.choice]: a.confidence, [a.second ?? NO_FAMILY]: 1 - a.confidence },
            confidence: a.confidence,
          },
        },
        usage: { input_tokens: 3000, output_tokens: 20 },
      }),
      { status: 200 }
    );
  };
  return new TypeSafeClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe("ruleFold", () => {
  it("lands a rephrasing of a declared family on it, for free", () => {
    expect(ruleFold("environment-variable-missing")).toBe("missing-env-var");
    expect(ruleFold("Missing Environment Variables")).toBe("missing-env-var");
    expect(ruleFold("missing-required-field")).toBe("missing-required-argument");
  });

  it("returns nothing for a name the taxonomy does not declare", () => {
    // This is the case that costs a classification — and the only one.
    expect(ruleFold("bgp-session-flapping")).toBeNull();
    expect(ruleFold("error")).toBeNull();
  });
});

describe("the question", () => {
  it("offers every declared family and a way out of them", () => {
    const q = familyQuestion();
    expect(Object.keys(q.criteria)).toHaveLength(CANONICAL_FAMILIES.length + 1);
    expect(q.criteria[NO_FAMILY]).toBeTruthy();
    // Every option must be answerable from its rubric alone.
    for (const f of CANONICAL_FAMILIES) expect(q.criteria[f.tag]).toBe(f.criteria);
  });

  it("shows the errors themselves, and the article when one exists", () => {
    const state = clusterState({
      proposal: "env-var-missing",
      errorCount: 9,
      repoCount: 2,
      samples: [{ message: "FOO is not set", repo: "a/one" }],
      article: { slug: "s", title: "Missing env var", summary: "about env vars" },
    });
    expect(state.example_errors).toEqual(["a/one: FOO is not set"]);
    expect(state.proposed_family_name).toBe("env-var-missing");
    expect(state.existing_article).toMatchObject({ title: "Missing env var" });
  });
});

describe("classifyCluster", () => {
  const cluster = {
    proposal: "bgp-session-flapping",
    errorCount: 9,
    repoCount: 2,
    samples: [{ message: "peer reset the session", repo: "a/one" }],
  };

  it("takes a confident answer and records what came second", async () => {
    const d = await classifyCluster(
      scripted([{ choice: "connection-reset", confidence: 0.82, second: "connection-refused" }]),
      cluster
    );
    expect(d).toMatchObject({
      proposal: "bgp-session-flapping",
      canonical: "connection-reset",
      method: "model",
      runnerUp: "connection-refused",
      model: "jev-1.13.0",
    });
  });

  it("parks an answer under the gate instead of guessing with it", async () => {
    // A wrong fold is worse than no fold: it files the record under an article
    // that does not describe it, and nothing downstream asks again.
    const d = await classifyCluster(
      scripted([{ choice: "connection-reset", confidence: CONFIDENCE_THRESHOLD - 0.01 }]),
      cluster
    );
    expect(d.canonical).toBeNull();
    expect(d.confidence).toBeCloseTo(CONFIDENCE_THRESHOLD - 0.01, 5);
  });

  it("parks a confident no-match, which is how the taxonomy learns it is short", async () => {
    const d = await classifyCluster(scripted([{ choice: NO_FAMILY, confidence: 0.95 }]), cluster);
    expect(d.canonical).toBeNull();
  });
});

describe("classifyPending", () => {
  it("spends calls only on proposals the spelling fold cannot place", async () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "environment-variable-missing", "FOO is not set", 4);
      seed(db, "a/one", "bgp-session-flapping", "peer reset the session", 9);
      const client = scripted([{ choice: "connection-reset", confidence: 0.8 }]);

      const res = await classifyPending(db, client, {});

      expect(res.byRule).toBe(1);
      expect(res.byModel).toBe(1);
      expect(res.calls).toBe(1);
      expect(res.recordsDecided).toBe(13);
      expect(decisionMap(db)).toEqual(
        new Map([
          ["environment-variable-missing", "missing-env-var"],
          ["bgp-session-flapping", "connection-reset"],
        ])
      );
    } finally {
      raw.close();
    }
  });

  it("does not re-decide a proposal it has already ruled on", async () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", "peer reset the session", 9);
      db.insert(tagDecisions)
        .values({
          proposal: "bgp-session-flapping",
          canonical: "connection-reset",
          method: "manual",
          confidence: null,
          runnerUp: null,
          model: null,
          decidedAt: "2026-09-22T00:00:00Z",
        })
        .run();

      expect(pendingProposals(db)).toEqual([]);
      const res = await classifyPending(db, scripted([{ choice: "file-not-found", confidence: 1 }]), {});
      expect(res.calls).toBe(0);
      expect(decisionMap(db).get("bgp-session-flapping")).toBe("connection-reset");
    } finally {
      raw.close();
    }
  });

  it("shows the classifier the article written about the proposal", async () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", "peer reset the session", 9);
      db.insert(infoPages)
        .values({
          slug: "bgp-session-flapping",
          clusterKey: "tag:bgp-session-flapping",
          title: "BGP sessions that flap",
          summary: "A peer drops an established session",
          background: "b",
          commonCauses: [],
          fixes: [],
          guideSlugs: [],
          errorIds: [],
          errorCount: 9,
          repoCount: 1,
          generatedAt: "2026-09-05T00:00:00Z",
        })
        .run();

      const cluster = pendingProposals(db)[0]!;
      expect(cluster.article?.title).toBe("BGP sessions that flap");
    } finally {
      raw.close();
    }
  });

  it("reports what it could not place, weighted by how much rides on it", async () => {
    const { db, raw } = openDb(tmpDbPath());
    try {
      seed(db, "a/one", "bgp-session-flapping", "peer reset the session", 9);
      seed(db, "b/two", "quantum-decoherence", "state collapsed", 2);

      await classifyPending(db, scripted([{ choice: NO_FAMILY, confidence: 0.9, second: "connection-reset" }]), {});

      const candidates = candidateProposals(db);
      expect(candidates.map((c) => [c.proposal, c.errorCount])).toEqual([
        ["bgp-session-flapping", 9],
        ["quantum-decoherence", 2],
      ]);
      expect(candidates[0]!.runnerUp).toBe("connection-reset");
    } finally {
      raw.close();
    }
  });
});
