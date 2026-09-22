/**
 * Which sections of a page does family classification actually need, and
 * which pages cannot be classified at all?
 *
 * usage:
 *   devkey run typesafe -- tsx scripts/tag-ablation.ts --db <path> --out <dir>
 *     [--taxonomy <tag-taxonomy.json>] [--pages 400] [--seed 7] [--arms a,b]
 *
 * Draws a reproducible random sample of pages, has the curate provider label
 * them against the taxonomy with the whole page in view (ERRLOOKUP_CONFIG
 * picks the provider), then scores each arm — a rule, or Jev shown a chosen
 * set of sections — against those labels. Labels and every arm's answers are
 * checkpointed in --out, so a rerun with another arm pays only for that arm.
 *
 * Writes report.md and results.json to --out. Read-only on the database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CANONICAL_FAMILIES, normalizeTag, tagKey, type CanonicalFamily } from "@errlookup/schema";
import { openDb } from "../src/db/client.js";
import { loadConfig } from "../src/config/index.js";
import { buildProviders } from "../src/providers.js";
import { TypeSafeClient, jevCostUsd } from "../src/provider/typesafe.js";
import { mapPool } from "../src/util/pool.js";
import { contentFamily } from "../src/phase/tag-shape.js";
import {
  samplePages,
  classifyPagesFlat,
  classifyPagesTwoStage,
  PAGES_PER_REQUEST,
  type Page,
  type PageDecision,
  type StateField,
} from "../src/phase/tag-page.js";
import { labelPages, type Label } from "../src/phase/tag-audit.js";

/** An arm: how a page gets a family. */
interface Arm {
  name: string;
  what: string;
  kind: "rule" | "flat" | "two-stage";
  fields?: StateField[];
  rule?: (p: Page, families: readonly CanonicalFamily[]) => string | null;
}

const foldName = (proposal: string | null, families: readonly CanonicalFamily[]): string | null => {
  const tag = normalizeTag(proposal);
  if (!tag) return null;
  const key = tagKey(tag);
  return families.find((f) => tagKey(f.tag) === key)?.tag ?? null;
};

const ARMS: Arm[] = [
  { name: "rule-content", what: "exception class / errno / HTTP status rules, no model", kind: "rule", rule: (p) => contentFamily(p)?.family ?? null },
  { name: "rule-name", what: "the proposed name, folded by spelling onto a family, no model", kind: "rule", rule: (p, f) => foldName(p.proposal, f) },
  { name: "message", what: "message", kind: "flat", fields: ["message"] },
  { name: "message+signals", what: "message, class, code, status", kind: "flat", fields: ["message", "signals"] },
  { name: "+documentation", what: "… + explanation", kind: "flat", fields: ["message", "signals", "documentation"] },
  { name: "+triggers", what: "… + triggered-when", kind: "flat", fields: ["message", "signals", "documentation", "triggers"] },
  { name: "content-full", what: "every content section, no proposed name", kind: "flat", fields: ["message", "signals", "documentation", "triggers", "situations"] },
  { name: "full", what: "every section including the proposed name", kind: "flat", fields: ["message", "signals", "documentation", "triggers", "situations", "proposal"] },
  { name: "proposal-only", what: "the proposed name and nothing else", kind: "flat", fields: ["proposal"] },
  { name: "two-stage", what: "domain then family, on message + signals + explanation", kind: "two-stage", fields: ["message", "signals", "documentation"] },
];

/** Gate the production classifier uses; the calibration table below tests it. */
const GATE = 0.55;

interface ArmResult {
  arm: string;
  what: string;
  /** Pages the arm gave a family (at or above the gate for model arms). */
  answered: number;
  /** Pages whose answer matches a clear-or-likely label, declining included. */
  correct: number;
  gold: number;
  /** Correct over the whole gold set: what the arm gets right with no fallback. */
  accuracy: number;
  precision: number;
  coverage: number;
  accuracyClear: number;
  tokensPerPage: number;
  bands?: { band: string; pages: number; accuracy: number }[];
}

function score(arm: Arm, labels: Map<string, Label>, answers: Map<string, { family: string | null; confidence: number }>, tokens: number, pages: number): ArmResult {
  const gold = [...labels.values()].filter((l) => l.certainty !== "unclear");
  let answered = 0;
  let correct = 0;
  let answeredRight = 0;
  let clear = 0;
  let clearCorrect = 0;
  for (const l of gold) {
    const a = answers.get(l.id);
    const given = a && a.confidence >= GATE ? a.family : null;
    if (given !== null) answered++;
    // Declining is the right answer for a page the labeller says fits no
    // family; it counts toward accuracy but not toward precision, which is
    // about the families an arm actually hands out.
    const right = given === l.family;
    if (right) correct++;
    if (right && given !== null) answeredRight++;
    if (l.certainty === "clear") {
      clear++;
      if (right) clearCorrect++;
    }
  }
  const result: ArmResult = {
    arm: arm.name,
    what: arm.what,
    answered,
    correct,
    gold: gold.length,
    accuracy: correct / Math.max(gold.length, 1),
    precision: answeredRight / Math.max(answered, 1),
    coverage: answered / Math.max(gold.length, 1),
    accuracyClear: clearCorrect / Math.max(clear, 1),
    tokensPerPage: tokens / Math.max(pages, 1),
  };
  if (arm.kind !== "rule") {
    const bands: [string, number, number][] = [["<0.35", 0, 0.35], ["0.35-0.55", 0.35, 0.55], ["0.55-0.75", 0.55, 0.75], ["0.75-0.9", 0.75, 0.9], ["0.9+", 0.9, 1.01]];
    result.bands = bands.map(([band, lo, hi]) => {
      const inBand = gold.filter((l) => {
        const c = answers.get(l.id)?.confidence ?? -1;
        return c >= lo && c < hi;
      });
      const ok = inBand.filter((l) => answers.get(l.id)?.family === l.family).length;
      return { band, pages: inBand.length, accuracy: ok / Math.max(inBand.length, 1) };
    });
  }
  return result;
}

async function runArm(
  arm: Arm,
  pages: Page[],
  families: readonly CanonicalFamily[],
  client: TypeSafeClient | null,
  outDir: string
): Promise<{ answers: Map<string, { family: string | null; confidence: number }>; tokens: number }> {
  if (arm.kind === "rule") {
    return {
      answers: new Map(pages.map((p) => [p.id, { family: arm.rule!(p, families), confidence: 1 }])),
      tokens: 0,
    };
  }
  const file = join(outDir, `arm-${arm.name}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { decisions: PageDecision[]; tokens: number };
    return { answers: new Map(saved.decisions.map((d) => [d.id, { family: d.choice, confidence: d.confidence }])), tokens: saved.tokens };
  }
  if (!client) throw new Error(`arm ${arm.name} needs TYPESAFE_API_KEY`);
  const before = client.inputTokens;
  const batches: Page[][] = [];
  for (let i = 0; i < pages.length; i += PAGES_PER_REQUEST) batches.push(pages.slice(i, i + PAGES_PER_REQUEST));
  const decisions = (
    await mapPool(batches, 4, (b) =>
      arm.kind === "flat" ? classifyPagesFlat(client, b, arm.fields!, families) : classifyPagesTwoStage(client, b, arm.fields!, families)
    )
  ).flat();
  const tokens = client.inputTokens - before;
  writeFileSync(file, JSON.stringify({ decisions, tokens }));
  return { answers: new Map(decisions.map((d) => [d.id, { family: d.choice, confidence: d.confidence }])), tokens };
}

/** What the pages nothing can place have in common. */
function unplaceable(pages: Page[], labels: Map<string, Label>, best: Map<string, { family: string | null; confidence: number }>) {
  const stuck = pages.filter((p) => {
    const l = labels.get(p.id);
    const a = best.get(p.id);
    return l?.certainty === "unclear" || l?.family === null || !a || a.confidence < GATE || a.family === null;
  });
  const share = (xs: Page[], pred: (p: Page) => boolean) => xs.filter(pred).length / Math.max(xs.length, 1);
  const generic = new Set(["Error", "Exception", "RuntimeError", "RuntimeException", "ValueError", "anyhow::Error", "Exception"]);
  const profile = (xs: Page[]) => ({
    pages: xs.length,
    noProposal: share(xs, (p) => !p.proposal),
    genericClass: share(xs, (p) => !p.errorClass || generic.has(p.errorClass.split(/[.:]+/).pop() ?? "")),
    shortMessage: share(xs, (p) => p.errorMessage.length < 30),
    noDocumentation: share(xs, (p) => !p.documentation || p.documentation.length < 40),
    errorTypes: Object.entries(
      xs.reduce<Record<string, number>>((acc, p) => ((acc[p.errorType] = (acc[p.errorType] ?? 0) + 1), acc), {})
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  });
  return {
    stuck: profile(stuck),
    placed: profile(pages.filter((p) => !stuck.includes(p))),
    labelledUnclear: stuck.filter((p) => labels.get(p.id)?.certainty === "unclear" || labels.get(p.id)?.family === null).length,
    examples: stuck.slice(0, 12).map((p) => ({
      repo: p.repo,
      message: p.errorMessage.slice(0, 160),
      label: labels.get(p.id),
      jev: best.get(p.id),
    })),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      out: { type: "string" },
      taxonomy: { type: "string" },
      pages: { type: "string", default: "400" },
      seed: { type: "string", default: "7" },
      arms: { type: "string" },
    },
  });
  if (!values.db || !values.out) throw new Error("--db and --out are required");
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const families: CanonicalFamily[] = values.taxonomy
    ? (JSON.parse(readFileSync(values.taxonomy, "utf8")) as CanonicalFamily[])
    : [...CANONICAL_FAMILIES];

  const { db, raw } = openDb(resolve(values.db));
  try {
    const pages = samplePages(db, Number(values.pages), Number(values.seed));
    console.log(`${pages.length} pages drawn (seed ${values.seed}); ${families.length} families`);

    const cfg = loadConfig();
    const labels = await labelPages(buildProviders(cfg), cfg, pages, families, {
      checkpointFile: join(outDir, "labels.json"),
      onLog: (m) => console.log(`  ${m}`),
    });

    const client = process.env.TYPESAFE_API_KEY ? new TypeSafeClient() : null;
    const wanted = values.arms ? new Set(values.arms.split(",")) : null;
    const results: ArmResult[] = [];
    const answersByArm = new Map<string, Map<string, { family: string | null; confidence: number }>>();
    for (const arm of ARMS.filter((a) => !wanted || wanted.has(a.name))) {
      const { answers, tokens } = await runArm(arm, pages, families, client, outDir);
      answersByArm.set(arm.name, answers);
      const r = score(arm, labels, answers, tokens, pages.length);
      results.push(r);
      console.log(`  ${arm.name.padEnd(16)} accuracy ${pct(r.accuracy)}  precision ${pct(r.precision)}  coverage ${pct(r.coverage)}  ${Math.round(r.tokensPerPage)} tok/page`);
    }

    const best = results.filter((r) => r.arm !== "rule-content" && r.arm !== "rule-name").sort((a, b) => b.accuracy - a.accuracy)[0];
    const stuck = best ? unplaceable(pages, labels, answersByArm.get(best.arm)!) : null;
    const certainty = [...labels.values()].reduce<Record<string, number>>((acc, l) => ((acc[l.certainty] = (acc[l.certainty] ?? 0) + 1), acc), {});

    writeFileSync(join(outDir, "results.json"), JSON.stringify({ families: families.length, pages: pages.length, certainty, results, best: best?.arm, stuck }, null, 2));
    const lines = [
      `# Tag classification ablation`,
      ``,
      `${pages.length} random pages (seed ${values.seed}), ${families.length} families. Reference labels by the curate provider with the whole page: ${Object.entries(certainty).map(([k, v]) => `${k} ${v}`).join(", ")}. Scores are against the clear and likely labels; gate ${GATE}.`,
      ``,
      `| arm | reads | accuracy | precision | coverage | clear-label accuracy | tokens/page | $ per 100k pages |`,
      `|---|---|---|---|---|---|---|---|`,
      ...results.map((r) => `| ${r.arm} | ${r.what} | ${pct(r.accuracy)} | ${pct(r.precision)} | ${pct(r.coverage)} | ${pct(r.accuracyClear)} | ${Math.round(r.tokensPerPage)} | ${jevCostUsd(r.tokensPerPage * 100_000).toFixed(2)} |`),
      ``,
      `## Calibration (${best?.arm ?? "none"})`,
      ``,
      `| confidence | pages | accuracy |`,
      `|---|---|---|`,
      ...(best?.bands ?? []).map((b) => `| ${b.band} | ${b.pages} | ${pct(b.accuracy)} |`),
      ``,
      `## Pages nothing places`,
      ``,
      stuck
        ? `${stuck.stuck.pages} of ${pages.length} pages (${stuck.labelledUnclear} of them unclear or unplaceable to the labeller too). Compared with the pages that were placed: no proposal ${pct(stuck.stuck.noProposal)} vs ${pct(stuck.placed.noProposal)}, generic class ${pct(stuck.stuck.genericClass)} vs ${pct(stuck.placed.genericClass)}, message under 30 chars ${pct(stuck.stuck.shortMessage)} vs ${pct(stuck.placed.shortMessage)}, thin explanation ${pct(stuck.stuck.noDocumentation)} vs ${pct(stuck.placed.noDocumentation)}. Error types: ${stuck.stuck.errorTypes.map(([t, n]) => `${t} ${n}`).join(", ")}.`
        : "no model arm ran",
    ];
    writeFileSync(join(outDir, "report.md"), `${lines.join("\n")}\n`);
    console.log(`\n${join(outDir, "report.md")}`);
  } finally {
    raw.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
