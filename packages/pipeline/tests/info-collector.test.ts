import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { findNewClusters, collectInfoPages } from "../src/info/collector.js";
import { sampleCluster, clusterEvidence } from "../src/info/research.js";
import { buildDataset } from "../src/exporter/index.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import { tmpDbPath } from "./setup.js";

function cfg(): ReturnType<typeof mapConfig> {
  return mapConfig(
    parseKdl(['provider "bulk" { command "bulk" }', "defaults {", '  primary "bulk"', "}"].join("\n"))
  );
}

let idSeq = 0;
function errorRow(repo: string, code: string | null, cls: string | null = null, backgroundTag: string | null = null) {
  const n = idSeq++;
  return {
    id: n.toString(16).padStart(16, "0"),
    repo,
    slug: `boom-${n}`,
    errorCode: code,
    errorMessage: `connect ${code ?? cls}: connection refused ${n}`,
    messagePattern: "connection refused",
    errorType: "network",
    errorClass: cls,
    httpStatus: null,
    severity: "error",
    filePath: "src/a.js",
    lineNumber: 1,
    sourceCode: null,
    sourceCodeStart: null,
    sourceCodeEnd: null,
    githubUrl: "https://github.com/a/b/blob/x/src/a.js#L1",
    documentation: `docs for ${n}: the peer is not listening`,
    triggerScenarios: "server down",
    commonSituations: "",
    solutions: ["start the server"],
    exampleFix: null,
    handlingStrategy: null,
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: null,
    preventionTips: ["health-check first"],
    tags: ["network"],
    backgroundTag,
    analyzedSha: "a".repeat(40),
    analyzedAt: "2026-08-11T00:00:00Z",
    schemaVersion: 2,
  };
}

function seed(
  db: ReturnType<typeof openDb>["db"],
  repo: string,
  code: string | null,
  count: number,
  cls: string | null = null,
  backgroundTag: string | null = null
) {
  for (let i = 0; i < count; i++) db.insert(errors).values(errorRow(repo, code, cls, backgroundTag)).run();
}

/** A draft that clears the deterministic gate: real paragraphs, real causes. */
const GOOD_DRAFT = {
  title: "ECONNREFUSED: the peer refused the connection",
  summary:
    "ECONNREFUSED is what a client sees when its TCP handshake reaches the host but nothing is listening on the port it asked for. Libraries surface it on connect or on the first read, usually as a network error carrying the address that was tried.",
  background:
    "The operating system returns ECONNREFUSED when a SYN arrives at a reachable host and no socket is bound to the destination port. The host is up and routable, which is what separates this from a timeout: the refusal comes back immediately, as an RST, rather than the connection attempt expiring.\n\nLibraries differ in where the refusal surfaces. Clients that connect lazily raise it on the first request, so the stack trace points at a call site far from any connection setup, while pooled clients raise it at pool warm-up and the same underlying condition looks like a startup failure instead, long before any application code runs.",
  commonCauses: [
    {
      cause: "service not running",
      detail: "Nothing is listening on the target port, so the kernel answers the handshake with a refusal.",
    },
    {
      cause: "wrong port or address",
      detail: "The process is up but bound elsewhere — a different port, or loopback only while the client dials the LAN address.",
    },
    {
      cause: "container or network boundary",
      detail: "The name resolves to a host the service does not run on, which is common when a compose service is addressed as localhost.",
    },
  ],
  fixes: [
    "Confirm something is listening on that exact address and port before treating it as a client bug.",
    "Retry with backoff only for start-up ordering; a refusal from a steady-state service is a configuration error, not a transient one.",
  ],
  guideSlugs: ["timeouts", "not-a-real-guide"],
};

const REVIEW_ACCEPT = { verdict: "accept" };

/**
 * Answers the draft call and the review call differently — the collector now
 * makes both, and a provider that returns a draft to the reviewer would look
 * like a reviewer that rejected the page.
 */
function draftProvider(draft: unknown, review: unknown = REVIEW_ACCEPT): LlmProvider {
  return {
    name: "bulk",
    async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
      const answer = prompt.includes("You are reviewing a background article") ? review : draft;
      return { ok: true, parsed: answer, raw: JSON.stringify(answer) };
    },
  };
}

describe("findNewClusters", () => {
  it("clusters by code, applies both thresholds, skips already-paged clusters", () => {
    const { db, raw } = openDb(tmpDbPath("info-clusters"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      seed(db, "a/one", "ELONELY", 9); // one repo only — not a family
      seed(db, "a/one", null, 3, "TypeError");
      seed(db, "b/two", null, 3, "TypeError");

      const found = findNewClusters(db, { minErrors: 5, minRepos: 2, limit: 10 });
      expect(found.map((c) => c.key).sort()).toEqual(["class:TypeError", "code:ECONNREFUSED"]);
      const conn = found.find((c) => c.key === "code:ECONNREFUSED")!;
      expect(conn.errorCount).toBe(6);
      expect(conn.repoCount).toBe(2);

      db.insert(infoPages)
        .values({
          slug: "econnrefused",
          clusterKey: "code:ECONNREFUSED",
          title: "t",
          summary: "s",
          background: "b",
          commonCauses: [],
          fixes: [],
          guideSlugs: [],
          errorIds: [],
          errorCount: 6,
          repoCount: 2,
          generatedAt: "2026-08-11T00:00:00Z",
        })
        .run();
      const again = findNewClusters(db, { minErrors: 5, minRepos: 2, limit: 10 });
      expect(again.map((c) => c.key)).toEqual(["class:TypeError"]);
    } finally {
      raw.close();
    }
  });

  it("excludes generic class/tag families but never codes", () => {
    const { db, raw } = openDb(tmpDbPath("info-generic"));
    try {
      seed(db, "a/one", null, 3, "Error");
      seed(db, "b/two", null, 3, "Error"); // class:Error — the cluster the first run wasted its page on
      seed(db, "a/one", null, 3, "Exception");
      seed(db, "b/two", null, 3, "Exception");
      seed(db, "a/one", null, 3, null, "error");
      seed(db, "b/two", null, 3, null, "error"); // tag:error — same word, same rule
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3); // codes are inherently specific

      const found = findNewClusters(db, { minErrors: 5, minRepos: 2, limit: 10 });
      expect(found.map((c) => c.key)).toEqual(["code:ECONNREFUSED"]);
    } finally {
      raw.close();
    }
  });

  it("clusters by backgroundTag across records that share neither code nor class", () => {
    const { db, raw } = openDb(tmpDbPath("info-tag"));
    try {
      seed(db, "a/one", "EONE", 3, null, "connection-refused");
      seed(db, "b/two", null, 3, "SocketError", "connection-refused");

      const found = findNewClusters(db, { minErrors: 5, minRepos: 2, limit: 10 });
      const tag = found.find((c) => c.key === "tag:connection-refused");
      expect(tag).toBeDefined();
      expect(tag!.errorCount).toBe(6);
      expect(tag!.repoCount).toBe(2);
    } finally {
      raw.close();
    }
  });
});

describe("collectInfoPages", () => {
  it("writes a validated page per cluster and is idempotent on the second run", async () => {
    const { db, raw } = openDb(tmpDbPath("info-collect"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      const logs: string[] = [];
      const res = await collectInfoPages(db, { bulk: draftProvider(GOOD_DRAFT) }, cfg(), {
        onLog: (m) => logs.push(m),
      });
      expect(res.created).toEqual(["econnrefused"]);
      expect(res.failed).toBe(0);

      const row = db.select().from(infoPages).all()[0]!;
      expect(row.clusterKey).toBe("code:ECONNREFUSED");
      expect(row.errorCount).toBe(6);
      expect(row.errorIds.length).toBe(6);
      // Unknown guide slug dropped; deterministic matcher adds the family's
      // real guide (message matches connection-failures) alongside the model's pick.
      expect(row.guideSlugs).toContain("timeouts");
      expect(row.guideSlugs).toContain("connection-failures");
      expect(row.guideSlugs).not.toContain("not-a-real-guide");

      const second = await collectInfoPages(db, { bulk: draftProvider(GOOD_DRAFT) }, cfg(), {});
      expect(second.created).toEqual([]);
      expect(db.select().from(infoPages).all()).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it("rejects an invalid draft, logs why, and writes nothing", async () => {
    const { db, raw } = openDb(tmpDbPath("info-reject"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      const logs: string[] = [];
      const res = await collectInfoPages(db, { bulk: draftProvider({ title: "only a title" }) }, cfg(), {
        onLog: (m) => logs.push(m),
      });
      expect(res.created).toEqual([]);
      expect(res.failed).toBe(1);
      expect(db.select().from(infoPages).all()).toHaveLength(0);
      expect(logs.some((l) => l.includes("failed validation"))).toBe(true);
      expect(logs.some((l) => l.includes("abandoned"))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("refuses a draft that names a library the family does not contain", async () => {
    const { db, raw } = openDb(tmpDbPath("info-invented"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      const invented = {
        ...GOOD_DRAFT,
        background: `${GOOD_DRAFT.background} The same refusal is reported by expressjs/express and by fastify/fastify, which surface it through their own transports.`,
      };
      const logs: string[] = [];
      const res = await collectInfoPages(db, { bulk: draftProvider(invented) }, cfg(), {
        onLog: (m) => logs.push(m),
      });
      expect(res.created).toEqual([]);
      expect(res.failed).toBe(1);
      expect(logs.some((l) => l.includes("names libraries the family does not contain"))).toBe(true);
      expect(db.select().from(infoPages).all()).toHaveLength(0);
    } finally {
      raw.close();
    }
  });

  it("publishes the reviewer's revision when the reviewer rejects the draft", async () => {
    const { db, raw } = openDb(tmpDbPath("info-revise"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      const revision = { ...GOOD_DRAFT, title: "ECONNREFUSED: nothing is listening on that port" };
      const logs: string[] = [];
      const res = await collectInfoPages(
        db,
        { bulk: draftProvider(GOOD_DRAFT, { verdict: "revise", issues: ["the title overstates it"], revision }) },
        cfg(),
        { onLog: (m) => logs.push(m) }
      );
      expect(res.created).toEqual(["econnrefused"]);
      expect(db.select().from(infoPages).all()[0]!.title).toBe(revision.title);
      expect(logs.some((l) => l.includes("revised by review"))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("writes nothing when the reviewer rejects without offering a revision", async () => {
    const { db, raw } = openDb(tmpDbPath("info-review-reject"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      const logs: string[] = [];
      const res = await collectInfoPages(
        db,
        { bulk: draftProvider(GOOD_DRAFT, { verdict: "revise", issues: ["the mechanism is not in the records"] }) },
        cfg(),
        { onLog: (m) => logs.push(m) }
      );
      expect(res.created).toEqual([]);
      expect(res.failed).toBe(1);
      expect(db.select().from(infoPages).all()).toHaveLength(0);
      expect(logs.some((l) => l.includes("rejected by review"))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("samples across the family's libraries instead of one library's longest entries", () => {
    const { db, raw } = openDb(tmpDbPath("info-sample"));
    try {
      // One repo holds most of the records; a depth-first sample would return
      // only its rows and the article would generalize from one library.
      seed(db, "a/loud", "ECONNREFUSED", 20);
      seed(db, "b/quiet", "ECONNREFUSED", 2);
      seed(db, "c/quiet", "ECONNREFUSED", 2);
      const cluster = findNewClusters(db, { minErrors: 5, minRepos: 2, limit: 5 })[0]!;
      const samples = sampleCluster(db, cluster, 30);
      expect(new Set(samples.map((s) => s.repo))).toEqual(new Set(["a/loud", "b/quiet", "c/quiet"]));
      expect(samples.filter((s) => s.repo === "a/loud").length).toBeLessThanOrEqual(4);

      const evidence = clusterEvidence(db, cluster);
      expect(evidence.repos[0]).toEqual({ repo: "a/loud", errorCount: 20 });
      expect(evidence.codes[0]).toEqual({ value: "ECONNREFUSED", errorCount: 24 });
    } finally {
      raw.close();
    }
  });

  it("exports pages as info/index.json plus one file per slug", async () => {
    const { db, raw } = openDb(tmpDbPath("info-export"));
    try {
      seed(db, "a/one", "ECONNREFUSED", 3);
      seed(db, "b/two", "ECONNREFUSED", 3);
      await collectInfoPages(db, { bulk: draftProvider(GOOD_DRAFT) }, cfg(), {});

      const { files, manifest } = buildDataset(db, { datasetVersion: "2026-08-11T00:00:00.000Z" });
      const paths = files.map((f) => f.relPath);
      expect(paths).toContain("info/index.json");
      expect(paths).toContain("info/econnrefused.json");
      const index = JSON.parse(files.find((f) => f.relPath === "info/index.json")!.content);
      expect(index).toHaveLength(1);
      expect(index[0].slug).toBe("econnrefused");
      expect((manifest as { counts: { infoPages: number } }).counts.infoPages).toBe(1);
    } finally {
      raw.close();
    }
  });
});
