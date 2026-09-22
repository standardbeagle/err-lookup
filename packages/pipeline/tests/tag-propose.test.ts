import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/client.js";
import { errors, infoPages } from "../src/db/schema.js";
import { mapConfig } from "../src/config/index.js";
import { parseKdl } from "../src/config/kdl.js";
import type { LlmProvider, InvokeOptions, ProviderResult } from "../src/provider/types.js";
import type { Cell } from "../src/phase/tag-cells.js";
import {
  validateCellDraft,
  poolDrafts,
  validateConsolidation,
  applyConsolidation,
  proposeTaxonomy,
  type CellDraft,
  type PooledFamily,
} from "../src/phase/tag-propose.js";
import { tmpDbPath } from "./setup.js";

const RUBRIC = "A required environment variable is unset or empty when it is read. For a variable that is set but unusable use invalid-env-var-value.";

function cell(key: string, members: [string, number][]): Cell {
  return {
    key,
    mode: "absent",
    object: "config",
    subject: null,
    errorCount: members.reduce((s, [, n]) => s + n, 0),
    members: members.map(([proposal, errorCount]) => ({ proposal, errorCount, repoCount: 2 })),
    incumbents: [],
    articles: [],
  };
}

const envCell = cell("absent×config", [
  ["missing-env-var", 60],
  ["environment-variable-missing", 30],
  ["missing-config-key", 20],
]);

const good = (): CellDraft => ({
  families: [
    {
      tag: "missing-env-var",
      domain: "configuration",
      criteria: RUBRIC,
      members: ["missing-env-var", "environment-variable-missing"],
      reuses: "missing-env-var",
    },
  ],
  notFamily: ["missing-config-key"],
  reasoning: "all env reads",
});

describe("validateCellDraft", () => {
  it("accepts a well-formed answer", () => {
    expect(validateCellDraft(good(), envCell)).toEqual([]);
  });

  it("names every problem so the repair round can fix exactly those", () => {
    const d = good();
    d.families[0]!.members.push("never-listed");
    d.families[0]!.domain = "vibes";
    d.notFamily.push("missing-env-var");
    const issues = validateCellDraft(d, envCell);
    expect(issues.join("\n")).toContain('"never-listed" is not in the NAMES list');
    expect(issues.join("\n")).toContain('domain "vibes"');
    expect(issues.join("\n")).toContain('"missing-env-var" is also assigned to notFamily');
  });

  it("holds a reused family to its current name", () => {
    const d = good();
    d.families[0]!.tag = "env-var-not-set";
    expect(validateCellDraft(d, envCell).join()).toContain("keep the current tag");
    const e = good();
    e.families[0]!.reuses = null;
    expect(validateCellDraft(e, envCell).join()).toContain('set "reuses"');
  });

  it("refuses a rubric that only says the name back, and a generic name", () => {
    const d = good();
    d.families.push({ tag: "error", domain: "configuration", criteria: RUBRIC, members: [], reuses: null });
    d.families[0]!.criteria = "Missing env var: the env var is missing.";
    const issues = validateCellDraft(d, envCell).join("\n");
    expect(issues).toContain("criteria must be one line of 60-450");
    expect(issues).toContain('"error" is too generic');
  });
});

describe("poolDrafts", () => {
  it("treats one tag from two cells as one family, keeping the heavier cell's rubric", () => {
    const other = cell("absent×config:env", [["env-var-missing", 200]]);
    const pooled = poolDrafts([
      { cell: envCell, draft: good() },
      {
        cell: other,
        draft: {
          families: [
            { tag: "missing-env-var", domain: "configuration", criteria: `${RUBRIC} Heavier.`, members: ["env-var-missing"], reuses: "missing-env-var" },
          ],
          notFamily: [],
          reasoning: "",
        },
      },
    ]);
    const f = pooled.get("missing-env-var")!;
    expect(f.errorCount).toBe(290);
    expect(f.cells).toEqual(["absent×config", "absent×config:env"]);
    expect(f.criteria).toBe(`${RUBRIC} Heavier.`);
  });
});

function pooledFamily(tag: string, errorCount: number, extra: Partial<PooledFamily> = {}): PooledFamily {
  return { tag, domain: "configuration", criteria: RUBRIC, errorCount, members: [tag], cells: [], reuses: null, origin: "cell", articles: [], ...extra };
}

describe("consolidation", () => {
  const pool = () =>
    new Map(
      [
        pooledFamily("missing-env-var", 900),
        pooledFamily("env-var-unset", 40),
        pooledFamily("config-vibes", 5),
        pooledFamily("missing-environment-variable", 12),
      ].map((f) => [f.tag, f])
    );

  it("refuses tags that are not in the list and contradictory instructions", () => {
    const issues = validateConsolidation(
      {
        merges: [{ into: "missing-env-var", from: ["env-var-unset", "missing-env-var"], reason: "same" }],
        criteria: [{ tag: "made-up", criteria: RUBRIC }],
        drops: [{ tag: "env-var-unset", reason: "thin" }],
      },
      pool()
    ).join("\n");
    expect(issues).toContain('"missing-env-var" merges into itself');
    expect(issues).toContain('"made-up" is not in the list');
    expect(issues).toContain('"env-var-unset" is already merged into missing-env-var');
  });

  it("merges, drops, and folds names the resolver would treat as one", () => {
    const { families, changes } = applyConsolidation(pool(), {
      merges: [{ into: "missing-env-var", from: ["env-var-unset"], reason: "same fault" }],
      criteria: [],
      drops: [{ tag: "config-vibes", reason: "too vague" }],
    });
    // missing-environment-variable spells missing-env-var; no model is
    // trusted to notice that, so the fold is deterministic.
    expect(families.map((f) => f.tag)).toEqual(["missing-env-var"]);
    expect(families[0]!.errorCount).toBe(952);
    expect(families[0]!.members).toEqual(
      expect.arrayContaining(["env-var-unset", "missing-environment-variable"])
    );
    expect(changes.map((c) => [c.tag, c.change])).toEqual([
      ["env-var-unset", "merged"],
      ["config-vibes", "dropped"],
      ["missing-environment-variable", "key-clash"],
    ]);
  });
});

// ---- end to end, with a scripted model ----------------------------------

let idSeq = 0;
function seed(db: ReturnType<typeof openDb>["db"], proposal: string, count: number, backgroundTag: string | null = null) {
  for (let i = 0; i < count; i++) {
    const n = idSeq++;
    db.insert(errors)
      .values({
        id: n.toString(16).padStart(16, "0"),
        repo: `org/repo-${i % 3}`,
        slug: `boom-${n}`,
        errorCode: null,
        errorMessage: `${proposal} is required`,
        messagePattern: "m",
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
        backgroundTagRaw: proposal,
        analyzedSha: "a".repeat(40),
        analyzedAt: "2026-08-11T00:00:00Z",
        schemaVersion: 2,
      })
      .run();
  }
}

function cfg() {
  return mapConfig(parseKdl(['provider "bulk" { command "bulk" }', "defaults {", '  primary "bulk"', "}"].join("\n")));
}

/** Answers cell prompts and the consolidation prompt, and counts both. */
function scripted(cellAnswer: (prompt: string) => unknown, consolidation: unknown) {
  const calls = { cell: 0, consolidation: 0 };
  const provider: LlmProvider = {
    name: "bulk",
    async invoke(prompt: string, _o: InvokeOptions): Promise<ProviderResult> {
      const isConsolidation = prompt.startsWith("You are reviewing a proposed family taxonomy");
      if (isConsolidation) calls.consolidation++;
      else calls.cell++;
      const answer = isConsolidation ? consolidation : cellAnswer(prompt);
      return { ok: true, parsed: answer, raw: JSON.stringify(answer) };
    },
  };
  return { providers: { bulk: provider }, calls };
}

describe("proposeTaxonomy", () => {
  function corpus() {
    const { db, raw } = openDb(tmpDbPath("propose"));
    seed(db, "missing-env-var", 90, "missing-env-var");
    seed(db, "environment-variable-missing", 30);
    db.insert(infoPages)
      .values({
        slug: "environment-variable-missing",
        clusterKey: "tag:environment-variable-missing",
        title: "t",
        summary: "s",
        background: "b",
        commonCauses: [],
        fixes: [],
        guideSlugs: [],
        errorIds: [],
        errorCount: 30,
        repoCount: 1,
        generatedAt: "2026-09-05T00:00:00Z",
      })
      .run();
    return { db, raw };
  }

  const cellAnswer = () => ({
    families: [
      {
        tag: "missing-env-var",
        domain: "configuration",
        criteria: RUBRIC,
        members: ["missing-env-var", "environment-variable-missing"],
        reuses: "missing-env-var",
      },
    ],
    notFamily: [],
    reasoning: "env reads",
  });
  const noChanges = { merges: [], criteria: [], drops: [] };

  it("writes a proposal in the taxonomy's own shape and says where each article lands", async () => {
    const { db, raw } = corpus();
    const outDir = mkdtempSync(join(tmpdir(), "propose-out-"));
    try {
      const { providers } = scripted(cellAnswer, noChanges);
      const res = await proposeTaxonomy(db, providers, cfg(), { outDir, minErrors: 50 });
      if (!("report" in res)) throw new Error(`cells failed: ${res.failedCells}`);

      const proposed = JSON.parse(readFileSync(res.taxonomyFile, "utf8")) as { tag: string }[];
      expect(proposed.map((f) => f.tag)).toContain("missing-env-var");
      // Current families no candidate produced are carried, not lost.
      expect(proposed.map((f) => f.tag)).toContain("file-not-found");
      expect(res.report.articles).toEqual([
        { slug: "environment-variable-missing", family: "environment-variable-missing", lands: "missing-env-var" },
      ]);
      expect(res.report.contentRuleGaps).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it("resumes from its checkpoints instead of paying for the cells again", async () => {
    const { db, raw } = corpus();
    const outDir = mkdtempSync(join(tmpdir(), "propose-out-"));
    try {
      const first = scripted(cellAnswer, noChanges);
      await proposeTaxonomy(db, first.providers, cfg(), { outDir, minErrors: 50 });
      expect(first.calls.cell).toBe(1);

      const second = scripted(cellAnswer, noChanges);
      await proposeTaxonomy(db, second.providers, cfg(), { outDir, minErrors: 50 });
      expect(second.calls).toEqual({ cell: 0, consolidation: 0 });
    } finally {
      raw.close();
    }
  });

  it("never consolidates a trial — a partial run's weights are the sample's", async () => {
    const { db, raw } = corpus();
    const outDir = mkdtempSync(join(tmpdir(), "propose-out-"));
    try {
      const run = scripted(cellAnswer, noChanges);
      const res = await proposeTaxonomy(db, run.providers, cfg(), { outDir, minErrors: 50, maxCells: 1 });
      expect(res).toEqual({ trial: ["absent×config"] });
      expect(run.calls).toEqual({ cell: 1, consolidation: 0 });
      expect(existsSync(join(outDir, "tag-taxonomy.proposed.json"))).toBe(false);
    } finally {
      raw.close();
    }
  });

  it("tells the reviewer which families carry articles", async () => {
    const { db, raw } = corpus();
    const outDir = mkdtempSync(join(tmpdir(), "propose-out-"));
    try {
      let seen = "";
      const run = scripted(cellAnswer, noChanges);
      const inner = run.providers.bulk;
      run.providers.bulk = {
        name: "bulk",
        invoke: (prompt, o) => {
          if (prompt.startsWith("You are reviewing a proposed family taxonomy")) seen = prompt;
          return inner.invoke(prompt, o);
        },
      };
      await proposeTaxonomy(db, run.providers, cfg(), { outDir, minErrors: 50 });
      expect(seen).toMatch(/- missing-env-var \[configuration\] \d+ records, has an article/);
    } finally {
      raw.close();
    }
  });

  it("repairs a rejected answer once, then stops before consolidating without it", async () => {
    const { db, raw } = corpus();
    const outDir = mkdtempSync(join(tmpdir(), "propose-out-"));
    try {
      const bad = { families: [{ tag: "Missing Env", domain: "x", criteria: "short", members: [], reuses: null }], notFamily: [] };
      const run = scripted(() => bad, noChanges);
      const res = await proposeTaxonomy(db, run.providers, cfg(), { outDir, minErrors: 50 });
      expect(res).toEqual({ failedCells: ["absent×config"] });
      expect(run.calls).toEqual({ cell: 2, consolidation: 0 });
      expect(existsSync(join(outDir, "tag-taxonomy.proposed.json"))).toBe(false);
    } finally {
      raw.close();
    }
  });
});
