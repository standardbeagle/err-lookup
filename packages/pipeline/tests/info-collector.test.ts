import { describe, it, expect } from "vitest";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { findNewClusters, collectInfoPages } from "../src/info/collector.js";
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
function errorRow(repo: string, code: string | null, cls: string | null = null) {
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
    analyzedSha: "a".repeat(40),
    analyzedAt: "2026-08-11T00:00:00Z",
    schemaVersion: 2,
  };
}

function seed(db: ReturnType<typeof openDb>["db"], repo: string, code: string | null, count: number, cls: string | null = null) {
  for (let i = 0; i < count; i++) db.insert(errors).values(errorRow(repo, code, cls)).run();
}

const GOOD_DRAFT = {
  title: "ECONNREFUSED: connection refused",
  summary: "The peer machine actively refused the TCP connection.",
  background:
    "The OS returns ECONNREFUSED when a SYN reaches a host but nothing listens on the port.\n\nLibraries surface it as a network error on the first read or connect.",
  commonCauses: [{ cause: "service not running", detail: "Nothing listens on the target port." }],
  fixes: ["verify the service is up and the port matches"],
  guideSlugs: ["timeouts", "not-a-real-guide"],
};

function draftProvider(draft: unknown): LlmProvider {
  return {
    name: "bulk",
    async invoke(_p: string, _o: InvokeOptions): Promise<ProviderResult> {
      return { ok: true, parsed: draft, raw: JSON.stringify(draft) };
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
      expect(logs.some((l) => l.includes("rejected"))).toBe(true);
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
