import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  CANONICAL_FAMILIES,
  CANONICAL_TAGS,
  FAMILY_CHOICE_LIMIT,
  GENERIC_FAMILIES,
  normalizeTagShape,
  tagKey,
  type CanonicalFamily,
} from "@errlookup/schema";
import type { Db } from "../db/client.js";
import type { ErrlookupConfig } from "../config/index.js";
import type { LlmProvider } from "../provider/types.js";
import { runProvider, watchdogBudgetMs } from "../provider/run.js";
import { withTimeout } from "../util/watchdog.js";
import { mapPool } from "../util/pool.js";
import { buildCells, sampleCell, cellEvidence, CELL_MIN_ERRORS, type Cell, type CellSample, type CellEvidence } from "./tag-cells.js";
import { CONTENT_RULE_FAMILIES } from "./tag-shape.js";

/**
 * Propose a revised family taxonomy from the corpus.
 *
 * The candidates are procedural (`tag-cells.ts`): names pooled by failure
 * mode and object, weighted by records. A model then checks each one against
 * the pages it would cover — is this one family, several, or partly none? —
 * and names and describes whatever it keeps. A second model, the review
 * provider, sees the whole resulting list at once and does the one thing no
 * per-cell pass can: finds families that are the same fault arrived at from
 * two cells, and rubrics that overlap enough to split a classifier's vote.
 * That call runs under the `curate` role so a config can give it the
 * strongest model while per-cell drafts stay on the bulk one.
 *
 * Every model answer is held to deterministic checks with one repair round,
 * the same shape the info-page collector uses. The output is a file in the
 * shape of `tag-taxonomy.json` plus a report of what changed and which
 * articles land where. Nothing is adopted automatically: a proposal is read,
 * then copied over the taxonomy by hand.
 *
 * Each cell's validated answer is written to disk as it completes, so a run
 * that dies resumes where it stopped instead of paying for the cells again.
 */

/** The domains families are filed under. Closed, so the list stays scannable. */
export const DOMAINS: readonly string[] = [...new Set(CANONICAL_FAMILIES.map((f) => f.domain))];

/**
 * Longest rubric a model may write. The first full proposal wrote rubrics
 * twice the length of the hand-written ones (median 302 characters against
 * 140); the ablation measured them less accurate and 78% more expensive per
 * classified page, since every page's question carries every rubric. The
 * current list's 90th percentile is 203.
 */
export const RUBRIC_MAX_CHARS = 300;

/** Proposed names shown per cell; the model assigns only these. */
export const MEMBERS_SHOWN = 30;

/** Pages shown per cell, one per library. */
export const SAMPLES_SHOWN = 12;

/**
 * Attempts per cell: the first answer and two repairs. One repair was
 * measured too few on the widest cells, where the model splits a group into
 * eight families and a single slip in any of them fails the whole answer.
 */
export const CELL_ROUNDS = 3;

/** One family as a model proposes it for a cell. */
export interface ProposedFamily {
  tag: string;
  domain: string;
  criteria: string;
  /** Proposed names from the cell's list that this family covers. */
  members: string[];
  /** The current family this continues, when it does. */
  reuses: string | null;
}

export interface CellDraft {
  families: ProposedFamily[];
  /** Proposed names in the cell whose errors do not share its fault. */
  notFamily: string[];
  reasoning: string;
}

const TAXONOMY_BLOCK = (): string =>
  CANONICAL_FAMILIES.map((f) => `- ${f.tag} [${f.domain}]: ${f.criteria}`).join("\n");

export function cellPrompt(
  cell: Cell,
  samples: CellSample[],
  evidence: CellEvidence,
  issues: readonly string[] = []
): string {
  const shown = cell.members.slice(0, MEMBERS_SHOWN);
  const names = shown.map((m) => `${m.proposal} (${m.errorCount})`).join(", ");
  const rest = cell.members.length - shown.length;
  const pages = samples
    .map(
      (s, i) =>
        `[${i}] ${s.repo}  (named "${s.proposal}")\n  message: ${s.message}` +
        (s.errorClass ? `\n  class: ${s.errorClass}` : "") +
        (s.httpStatus ? `\n  http status: ${s.httpStatus}` : "") +
        (s.documentation ? `\n  documentation: ${s.documentation}` : "")
    )
    .join("\n");
  const fixups = issues.length
    ? `\n\nA previous answer was REJECTED. Fix exactly these problems and change nothing else:\n${issues.map((i) => `- ${i}`).join("\n")}\n`
    : "";

  return `You are curating the family taxonomy of ErrLookup, a knowledge base of errors thrown by
open-source libraries. Every error page links to the one background article for its family,
so a family must be ONE kind of fault that a developer would search for by the same words and
fix the same way, whichever library raised it.

A procedure grouped the names earlier models gave these errors by failure mode and object.
You are checking one such group.

CANDIDATE: failure mode "${cell.mode}", object "${cell.object}${cell.subject ? `:${cell.subject}` : ""}"
${cell.errorCount} records under ${cell.members.length} distinct names.

NAMES in this group, with records (the heaviest ${shown.length}${rest > 0 ? `; ${rest} rarer names not shown` : ""}):
${names}

CURRENT FAMILIES these names already fold onto by spelling: ${cell.incumbents.map((i) => `${i.family} (${i.errorCount})`).join(", ") || "none"}
ARTICLES already written for names in this group: ${cell.articles.map((a) => `${a.slug} (for "${a.proposal}")`).join(", ") || "none"}

COUNTED over ${evidence.pages} random pages of the group:
- messages stating the group's own failure mode: ${(evidence.messageAgrees * 100).toFixed(0)}%
- messages stating a different specific failure mode: ${(evidence.messageDisagrees * 100).toFixed(0)}%
- error classes: ${evidence.classes.map((c) => `${c.value} (${c.count})`).join(", ") || "none recorded"}

${samples.length} PAGES from the group, one per library:
${pages}

THE CURRENT TAXONOMY. Reuse a family's exact tag whenever it describes the fault; propose a new
one only for a fault none of these covers:
${TAXONOMY_BLOCK()}${fixups}

Decide whether this group is one family, several, or partly no family at all, judging by
what went wrong in the pages rather than by the names. Then write JSON:
{"families": [{"tag": "...", "domain": "...", "criteria": "...", "members": ["..."], "reuses": "..."}],
 "notFamily": ["..."],
 "reasoning": "..."}

- families: one entry per family the group contains; usually one.
  - tag: kebab-case, the words a developer would search. The current tag when "reuses" is set.
  - domain: exactly one of: ${DOMAINS.join(", ")}.
  - criteria: for a NEW family only (a reused family keeps its current criteria, so copy
    them unchanged): ONE line of at most ${RUBRIC_MAX_CHARS} characters that a classifier will
    read with nothing else: what belongs, then the neighbouring family it is NOT
    ("... For X use other-tag."). Never just restate the tag.
  - members: names from the NAMES list above that belong to this family.
  - reuses: the current family's tag this continues, or null for a new family.
- notFamily: names from the NAMES list whose errors do not share the group's fault.
- reasoning: two or three sentences on what you saw in the pages.`;
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** A rubric that only says its own name back gives a classifier nothing to choose on. */
export function restatesName(tag: string, criteria: string): boolean {
  const words = tag.split("-");
  const lower = criteria.toLowerCase();
  return words.every((w) => lower.includes(w)) && criteria.length < 80;
}

function checkFamilyShape(f: ProposedFamily, where: string, issues: string[]): void {
  if (typeof f.tag === "string" && GENERIC_FAMILIES.has(f.tag)) {
    issues.push(`${where}: tag "${f.tag}" is too generic to carry an article`);
  } else if (typeof f.tag !== "string" || normalizeTagShape(f.tag) !== f.tag) {
    issues.push(`${where}: tag "${String(f.tag)}" is not lowercase kebab-case`);
  }
  if (!DOMAINS.includes(f.domain)) {
    issues.push(`${where}: domain "${String(f.domain)}" is not one of the listed domains`);
  }
  // A reused family keeps its current rubric, so only a new family's is held
  // to the length a model may write.
  const maxChars = f.reuses ? Number.POSITIVE_INFINITY : RUBRIC_MAX_CHARS;
  if (typeof f.criteria !== "string" || f.criteria.length < 60 || f.criteria.length > maxChars) {
    issues.push(`${where}: criteria must be one line of 60-${RUBRIC_MAX_CHARS} characters`);
  } else if (restatesName(f.tag, f.criteria)) {
    issues.push(`${where}: criteria only restates the tag — say what belongs and what does not`);
  } else if (/\n/.test(f.criteria)) {
    issues.push(`${where}: criteria must be a single line`);
  }
}

/**
 * Repair the member lists, which only weigh families and place articles in
 * the report; nothing about a family's name or rubric depends on them. A
 * member that is not in the NAMES list names nothing and is dropped; a name
 * put both in a family and in notFamily stays with the family, the positive
 * assignment. Everything that shapes the taxonomy is still validated
 * strictly by validateCellDraft. Returns what was changed, for the log.
 */
export function tidyCellMembers(draft: unknown, cell: Cell): string[] {
  if (!draft || typeof draft !== "object") return [];
  const d = draft as Partial<CellDraft>;
  if (!Array.isArray(d.families)) return [];
  const listed = new Set(cell.members.slice(0, MEMBERS_SHOWN).map((m) => m.proposal));
  const notes: string[] = [];
  const inFamily = new Set<string>();
  for (const f of d.families as Partial<ProposedFamily>[]) {
    const members = asStringArray(f.members);
    if (!members) continue;
    const kept = members.filter((m) => {
      if (listed.has(m) && !inFamily.has(m)) {
        inFamily.add(m);
        return true;
      }
      notes.push(listed.has(m) ? `"${m}" listed twice` : `unknown member "${m}" dropped`);
      return false;
    });
    f.members = kept;
  }
  const notFamily = asStringArray(d.notFamily);
  if (notFamily) {
    d.notFamily = notFamily.filter((m) => {
      if (!listed.has(m)) {
        notes.push(`unknown notFamily name "${m}" dropped`);
        return false;
      }
      if (inFamily.has(m)) {
        notes.push(`"${m}" kept in its family, dropped from notFamily`);
        return false;
      }
      return true;
    });
  }
  return notes;
}

/** Every reason a cell answer cannot be used, or none. */
export function validateCellDraft(draft: unknown, cell: Cell): string[] {
  const issues: string[] = [];
  if (!draft || typeof draft !== "object") return ["answer is not a JSON object"];
  const d = draft as Partial<CellDraft>;
  if (!Array.isArray(d.families)) return ['"families" must be an array'];
  const notFamily = d.notFamily === undefined ? [] : asStringArray(d.notFamily);
  if (!notFamily) return ['"notFamily" must be an array of names'];

  const listed = new Set(cell.members.slice(0, MEMBERS_SHOWN).map((m) => m.proposal));
  const claimed = new Map<string, string>();
  for (const name of notFamily) {
    if (!listed.has(name)) issues.push(`notFamily names "${name}", which is not in the NAMES list`);
    claimed.set(name, "notFamily");
  }
  if (d.families.length === 0 && notFamily.length === 0) {
    issues.push("no families and no notFamily names — say what this group is");
  }
  const tags = new Set<string>();
  d.families.forEach((raw, i) => {
    const f = raw as ProposedFamily;
    const where = `families[${i}]`;
    checkFamilyShape(f, where, issues);
    if (tags.has(f.tag)) issues.push(`${where}: tag "${f.tag}" is used twice`);
    tags.add(f.tag);
    if (f.reuses !== null && f.reuses !== undefined) {
      if (!CANONICAL_TAGS.has(f.reuses)) issues.push(`${where}: reuses "${f.reuses}", which is not a current family`);
      else if (f.tag !== f.reuses) issues.push(`${where}: reuses "${f.reuses}" but is tagged "${f.tag}" — keep the current tag`);
    } else if (CANONICAL_TAGS.has(f.tag)) {
      issues.push(`${where}: "${f.tag}" is a current family — set "reuses" to it`);
    }
    const members = asStringArray(f.members);
    if (!members) {
      issues.push(`${where}: members must be an array of names`);
      return;
    }
    for (const name of members) {
      if (!listed.has(name)) issues.push(`${where}: member "${name}" is not in the NAMES list`);
      const prior = claimed.get(name);
      if (prior) issues.push(`${where}: "${name}" is also assigned to ${prior}`);
      claimed.set(name, f.tag);
    }
  });
  return issues;
}

/** A family in the pooled proposal, with what it rests on. */
export interface PooledFamily extends CanonicalFamily {
  /** Records carried by the proposed names assigned to it. */
  errorCount: number;
  members: string[];
  cells: string[];
  /** The current family it continues, when it does. */
  reuses: string | null;
  /** "cell" when a candidate produced it; "carried" when it is a current family no candidate did. */
  origin: "cell" | "carried";
  /** Background articles keyed to this family or one of its members. */
  articles: string[];
}

/**
 * Pool the per-cell answers into one list. The same tag proposed from two
 * cells is one family; the rubric written against the heavier cell wins,
 * because it was written with more of the family in view.
 */
/** Slugs of the cell's articles keyed to one of the given members. */
function articlesFor(cell: Cell, members: string[]): string[] {
  const wanted = new Set(members);
  return cell.articles.filter((a) => wanted.has(a.proposal)).map((a) => a.slug);
}

export function poolDrafts(drafts: { cell: Cell; draft: CellDraft }[]): Map<string, PooledFamily> {
  const pooled = new Map<string, PooledFamily & { rubricWeight: number }>();
  for (const { cell, draft } of drafts) {
    const weightOf = new Map(cell.members.map((m) => [m.proposal, m.errorCount]));
    for (const f of draft.families) {
      const weight = f.members.reduce((s, m) => s + (weightOf.get(m) ?? 0), 0);
      const cur = pooled.get(f.tag);
      // A reused family keeps its current rubric and domain. Cell drafts
      // rewrote 108 of them in the first full run, and the rewritten list
      // classified worse than the one it replaced; a rubric changes only
      // through a targeted consolidation rewrite.
      const current = f.reuses ? CANONICAL_FAMILIES.find((c) => c.tag === f.reuses) : undefined;
      if (!cur) {
        pooled.set(f.tag, {
          tag: f.tag,
          domain: current?.domain ?? f.domain,
          criteria: current?.criteria ?? f.criteria,
          errorCount: weight,
          members: [...f.members],
          cells: [cell.key],
          reuses: f.reuses ?? null,
          origin: "cell",
          articles: articlesFor(cell, f.members),
          rubricWeight: weight,
        });
        continue;
      }
      cur.errorCount += weight;
      cur.members.push(...f.members);
      cur.cells.push(cell.key);
      cur.articles.push(...articlesFor(cell, f.members));
      if (!current && weight > cur.rubricWeight) {
        cur.criteria = f.criteria;
        cur.domain = f.domain;
        cur.rubricWeight = weight;
      }
    }
  }
  return new Map([...pooled].map(([k, { rubricWeight: _w, ...f }]) => [k, f]));
}

/**
 * Current families no candidate produced. They are not dropped silently:
 * each goes into the consolidation list marked as carried, with the records
 * that publish it today, so the reviewer can keep, merge or drop it with a
 * reason that lands in the report.
 */
export function carryForward(db: Db, pooled: Map<string, PooledFamily>): void {
  const articleOf = new Map(
    db
      .all<{ slug: string; cluster_key: string }>(sql`SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%'`)
      .map((p) => [p.cluster_key.slice(4), p.slug])
  );
  const counts = new Map(
    db
      .all<{ tag: string; n: number }>(sql`
        SELECT background_tag AS tag, count(*) AS n FROM errors
        WHERE background_tag IS NOT NULL GROUP BY background_tag
      `)
      .map((r) => [r.tag, r.n])
  );
  for (const f of CANONICAL_FAMILIES) {
    if (pooled.has(f.tag)) continue;
    pooled.set(f.tag, {
      ...f,
      errorCount: counts.get(f.tag) ?? 0,
      members: [],
      cells: [],
      reuses: f.tag,
      origin: "carried",
      articles: articleOf.has(f.tag) ? [articleOf.get(f.tag)!] : [],
    });
  }
}

export interface Consolidation {
  merges: { into: string; from: string[]; reason: string }[];
  criteria: { tag: string; criteria: string }[];
  drops: { tag: string; reason: string }[];
}

export function consolidationPrompt(families: PooledFamily[], issues: readonly string[] = []): string {
  const list = [...families]
    .sort((a, b) => a.domain.localeCompare(b.domain) || b.errorCount - a.errorCount)
    .map(
      (f) =>
        `- ${f.tag} [${f.domain}] ${f.errorCount} records` +
        (f.articles.length ? `, ${f.articles.length === 1 ? "has an article" : `${f.articles.length} articles`}` : "") +
        (f.origin === "carried" ? ", current family no candidate produced" : "") +
        (f.reuses ? "" : ", NEW") +
        `: ${f.criteria}`
    )
    .join("\n");
  const fixups = issues.length
    ? `\n\nA previous answer was REJECTED. Fix exactly these problems and change nothing else:\n${issues.map((i) => `- ${i}`).join("\n")}\n`
    : "";
  return `You are reviewing a proposed family taxonomy for ErrLookup, a knowledge base of errors thrown
by open-source libraries. Each family becomes one background article, and a classifier will
place every error page into exactly one family by reading the criteria below and nothing else.
The list was assembled from separate groups, so the same fault can appear twice under
different names, and neighbouring rubrics can overlap.

${families.length} PROPOSED FAMILIES (tag [domain] records: criteria):
${list}${fixups}

Find three things, and only where you are sure:
1. merges — families that are the SAME fault with the SAME fix, so a reader would want one
   article. Sharing a topic is not enough: an unset environment variable and a missing key in a
   config file are both "missing configuration" but are fixed in different places, so they stay
   separate; a narrower family that is fixed differently always stays separate. Keep the tag
   with more records unless its name is clearly worse. Merging two families that both have
   articles is welcome when they really are one fault — it resolves a duplicate — but merging
   away a family with an article only because it is small loses a page readers already find.
2. criteria — pairs whose rubrics overlap so that a classifier would split its vote. Rewrite
   the criteria of one or both so each names the other as what it is NOT. One line each, at
   most ${RUBRIC_MAX_CHARS} characters: every rubric is read for every page classified, so a
   longer rubric costs on every page and was measured to classify worse, not better.
3. drops — families too vague to be one article. Size alone is not a reason: a small family
   with a precise rubric costs nothing, and its pages would otherwise land somewhere that does
   not describe them.

Write JSON:
{"merges": [{"into": "tag", "from": ["tag"], "reason": "..."}],
 "criteria": [{"tag": "tag", "criteria": "..."}],
 "drops": [{"tag": "tag", "reason": "..."}]}
Use only tags from the list. Empty arrays are a fine answer.`;
}

export function validateConsolidation(c: unknown, families: Map<string, PooledFamily>): string[] {
  const issues: string[] = [];
  if (!c || typeof c !== "object") return ["answer is not a JSON object"];
  const x = c as Partial<Consolidation>;
  for (const key of ["merges", "criteria", "drops"] as const) {
    if (!Array.isArray(x[key])) issues.push(`"${key}" must be an array`);
  }
  if (issues.length) return issues;
  const touched = new Map<string, string>();
  const known = (tag: unknown, where: string): boolean => {
    if (typeof tag !== "string" || !families.has(tag)) {
      issues.push(`${where}: "${String(tag)}" is not in the list`);
      return false;
    }
    return true;
  };
  x.merges!.forEach((m, i) => {
    const where = `merges[${i}]`;
    if (!known(m.into, where)) return;
    const from = asStringArray(m.from);
    if (!from || from.length === 0) {
      issues.push(`${where}: "from" must list at least one tag`);
      return;
    }
    for (const t of from) {
      if (!known(t, where)) continue;
      if (t === m.into) issues.push(`${where}: "${t}" merges into itself`);
      const prior = touched.get(t);
      if (prior) issues.push(`${where}: "${t}" is already ${prior}`);
      touched.set(t, `merged into ${m.into}`);
    }
  });
  for (const m of x.merges!) {
    if (touched.has(m.into)) issues.push(`"${m.into}" is merged away and also a merge target`);
  }
  x.drops!.forEach((d, i) => {
    const where = `drops[${i}]`;
    if (!known(d.tag, where)) return;
    const prior = touched.get(d.tag);
    if (prior) issues.push(`${where}: "${d.tag}" is already ${prior}`);
    if (x.merges!.some((m) => m.into === d.tag)) issues.push(`${where}: "${d.tag}" is a merge target`);
    touched.set(d.tag, "dropped");
  });
  x.criteria!.forEach((r, i) => {
    const where = `criteria[${i}]`;
    if (!known(r.tag, where)) return;
    if (typeof r.criteria !== "string" || r.criteria.length < 60 || r.criteria.length > RUBRIC_MAX_CHARS || /\n/.test(r.criteria)) {
      issues.push(`${where}: criteria must be one line of 60-${RUBRIC_MAX_CHARS} characters`);
    } else if (restatesName(r.tag, r.criteria)) {
      issues.push(`${where}: criteria only restates the tag`);
    }
  });
  return issues;
}

/** What happened to a family on its way into the proposal. */
export interface FamilyChange {
  tag: string;
  change: "merged" | "dropped" | "criteria" | "key-clash" | "below-floor";
  into?: string;
  reason: string;
}

/**
 * Apply a validated consolidation, then enforce what no model is trusted
 * with: distinct spelling keys (two names the resolver treats as one family
 * are folded into the heavier) and the option cap.
 */
export function applyConsolidation(
  pooled: Map<string, PooledFamily>,
  c: Consolidation,
  minNewErrors = CELL_MIN_ERRORS
): { families: PooledFamily[]; changes: FamilyChange[] } {
  const families = new Map(
    [...pooled].map(([k, f]) => [k, { ...f, members: [...f.members], cells: [...f.cells], articles: [...f.articles] }])
  );
  const changes: FamilyChange[] = [];
  const absorb = (into: PooledFamily, from: PooledFamily): void => {
    into.errorCount += from.errorCount;
    // The absorbed family's own name becomes a member, so pages proposed
    // under it — and any article keyed to it — land here.
    into.members.push(...from.members, from.tag);
    into.cells.push(...from.cells);
    into.articles.push(...from.articles);
  };

  for (const m of c.merges) {
    const into = families.get(m.into)!;
    for (const t of m.from) {
      absorb(into, families.get(t)!);
      families.delete(t);
      changes.push({ tag: t, change: "merged", into: m.into, reason: m.reason });
    }
  }
  for (const d of c.drops) {
    families.delete(d.tag);
    changes.push({ tag: d.tag, change: "dropped", reason: d.reason });
  }
  for (const r of c.criteria) {
    const f = families.get(r.tag);
    if (!f) continue;
    f.criteria = r.criteria;
    changes.push({ tag: r.tag, change: "criteria", reason: "rewritten against an overlapping neighbour" });
  }

  const byKey = new Map<string, PooledFamily>();
  for (const f of [...families.values()].sort((a, b) => b.errorCount - a.errorCount)) {
    const key = tagKey(f.tag);
    const holder = byKey.get(key);
    if (holder) {
      absorb(holder, f);
      families.delete(f.tag);
      changes.push({ tag: f.tag, change: "key-clash", into: holder.tag, reason: `spells the same family as ${holder.tag}` });
      continue;
    }
    byKey.set(key, f);
  }

  // After the spelling fold, so a thin name that spells an existing family
  // lands its records there instead of losing them to the floor.
  // A new family has to carry as many records as a candidate cell must, or it
  // cannot carry an article and only splits the classifier's vote. The first
  // full run proposed 32 new families, 24 of them under this floor (one with
  // 2 records); the reviewer kept them because size alone is no reason to drop
  // a CURRENT family, which may have an article. That rule is right for current
  // families and wrong for new ones, so the floor is enforced here, in code.
  for (const f of [...families.values()]) {
    if (CANONICAL_TAGS.has(f.tag) || f.errorCount >= minNewErrors) continue;
    families.delete(f.tag);
    changes.push({ tag: f.tag, change: "below-floor", reason: `${f.errorCount} records, under the ${minNewErrors} a new family needs` });
  }

  const out = [...families.values()].sort((a, b) => a.domain.localeCompare(b.domain) || b.errorCount - a.errorCount);
  if (out.length > FAMILY_CHOICE_LIMIT) {
    throw new Error(
      `proposal has ${out.length} families, over the ${FAMILY_CHOICE_LIMIT}-option limit of one classification — raise the cell floor or merge before adopting`
    );
  }
  return { families: out, changes };
}

export interface ProposalReport {
  generatedAt: string;
  currentFamilies: number;
  proposedFamilies: number;
  totalErrors: number;
  uncelledErrors: number;
  cells: { key: string; errorCount: number; families: string[]; notFamily: number }[];
  kept: string[];
  added: { tag: string; errorCount: number; cells: string[] }[];
  removed: FamilyChange[];
  /** New families the model proposed that carried too few records to add. */
  belowFloor: FamilyChange[];
  criteriaChanged: string[];
  /** Where each family-keyed article lands; null means it would be orphaned. */
  articles: { slug: string; family: string; lands: string | null }[];
  /** Families a content rule names that the proposal no longer has. */
  contentRuleGaps: string[];
}

export function buildReport(
  db: Db,
  build: { totalErrors: number; uncelledErrors: number },
  cellResults: { cell: Cell; draft: CellDraft }[],
  families: PooledFamily[],
  changes: FamilyChange[]
): ProposalReport {
  const proposed = new Set(families.map((f) => f.tag));
  const landing = new Map<string, string>();
  for (const f of families) {
    landing.set(f.tag, f.tag);
    for (const m of f.members) if (!landing.has(m)) landing.set(m, f.tag);
  }
  const articles = db
    .all<{ slug: string; cluster_key: string }>(sql`SELECT slug, cluster_key FROM info_pages WHERE cluster_key LIKE 'tag:%'`)
    .map((p) => {
      const family = p.cluster_key.slice(4);
      return { slug: p.slug, family, lands: landing.get(family) ?? null };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    generatedAt: new Date().toISOString(),
    currentFamilies: CANONICAL_FAMILIES.length,
    proposedFamilies: families.length,
    totalErrors: build.totalErrors,
    uncelledErrors: build.uncelledErrors,
    cells: cellResults.map(({ cell, draft }) => ({
      key: cell.key,
      errorCount: cell.errorCount,
      families: draft.families.map((f) => f.tag),
      notFamily: draft.notFamily.length,
    })),
    kept: families.filter((f) => CANONICAL_TAGS.has(f.tag)).map((f) => f.tag),
    added: families
      .filter((f) => !CANONICAL_TAGS.has(f.tag))
      .map((f) => ({ tag: f.tag, errorCount: f.errorCount, cells: f.cells })),
    removed: changes.filter((c) => c.change !== "criteria" && CANONICAL_TAGS.has(c.tag)),
    belowFloor: changes.filter((c) => c.change === "below-floor"),
    criteriaChanged: families
      .filter((f) => CANONICAL_TAGS.has(f.tag) && CANONICAL_FAMILIES.find((c) => c.tag === f.tag)!.criteria !== f.criteria)
      .map((f) => f.tag),
    articles,
    contentRuleGaps: [...CONTENT_RULE_FAMILIES].filter((t) => !proposed.has(t)).sort(),
  };
}

/** Write a file whole or not at all — a half-written checkpoint is worse than none. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const cellFile = (dir: string, key: string): string =>
  join(dir, "cells", `${key.replace("×", "-x-").replace(/[^a-z0-9-]+/g, "-")}.json`);

export interface ProposeOptions {
  outDir: string;
  minErrors?: number;
  /** Ignore checkpoints and ask again. */
  fresh?: boolean;
  /**
   * Run only the heaviest N cells and stop before consolidation — for trying
   * the cell prompt on a few before paying for all of them.
   */
  maxCells?: number;
  onLog?: (msg: string) => void;
}

export interface ProposeResult {
  report: ProposalReport;
  taxonomyFile: string;
  reportFile: string;
  failedCells: string[];
}

/**
 * Run the proposal end to end. A cell whose answer still fails validation
 * after its repairs stops the run before consolidation: consolidating without it would publish
 * a taxonomy missing whatever that cell holds, and the checkpoints make the
 * rerun pay only for what failed.
 */
export async function proposeTaxonomy(
  db: Db,
  providers: Record<string, LlmProvider>,
  cfg: ErrlookupConfig,
  opts: ProposeOptions
): Promise<ProposeResult | { failedCells: string[] } | { trial: string[] }> {
  const log = opts.onLog ?? (() => {});
  mkdirSync(join(opts.outDir, "cells"), { recursive: true });
  const build = buildCells(db, { minErrors: opts.minErrors });
  const cells = opts.maxCells ? build.cells.slice(0, opts.maxCells) : build.cells;
  log(`propose: ${cells.length} candidate cells, ${build.totalErrors - build.uncelledErrors} of ${build.totalErrors} proposed records`);

  const cwd = mkdtempSync(join(tmpdir(), "errlookup-propose-"));
  const draftBudget = watchdogBudgetMs(cfg, "enrichment");
  const failed: string[] = [];
  const results: { cell: Cell; draft: CellDraft }[] = [];
  try {
    await mapPool(cells, cfg.defaults.batchConcurrency, async (cell) => {
      const file = cellFile(opts.outDir, cell.key);
      if (!opts.fresh && existsSync(file)) {
        // A checkpoint is held to today's rules, not the rules it was written
        // under: one that fails them is asked again rather than trusted.
        const cached = JSON.parse(readFileSync(file, "utf8")) as CellDraft;
        tidyCellMembers(cached, cell);
        if (validateCellDraft(cached, cell).length === 0) {
          results.push({ cell, draft: cached });
          return;
        }
        log(`propose: ${cell.key} checkpoint fails the current rules — asking again`);
      }
      const samples = sampleCell(db, cell, SAMPLES_SHOWN);
      const evidence = cellEvidence(db, cell);
      let issues: string[] = [];
      for (let round = 0; round < CELL_ROUNDS; round++) {
        try {
          const res = await withTimeout(
            runProvider(cellPrompt(cell, samples, evidence, issues), { cwd }, providers, cfg, "enrichment"),
            draftBudget
          );
          const tidied = tidyCellMembers(res.parsed, cell);
          if (tidied.length) log(`propose: ${cell.key} members tidied — ${tidied.slice(0, 3).join("; ")}`);
          issues = validateCellDraft(res.parsed, cell);
          if (issues.length === 0) {
            const draft = res.parsed as CellDraft;
            draft.notFamily ??= [];
            for (const f of draft.families) f.reuses ??= null;
            writeAtomic(file, JSON.stringify(draft, null, 2));
            results.push({ cell, draft });
            log(`propose: ${cell.key} → ${draft.families.map((f) => f.tag).join(", ") || "(no family)"}`);
            return;
          }
          log(`propose: ${cell.key} round ${round + 1} rejected — ${issues.slice(0, 3).join("; ")}`);
        } catch (err) {
          issues = [`the previous attempt failed: ${(err as Error).message.slice(0, 200)}`];
          log(`propose: ${cell.key} round ${round + 1} failed — ${(err as Error).message.slice(0, 200)}`);
        }
      }
      failed.push(cell.key);
    });

    if (failed.length > 0) return { failedCells: failed };
    if (opts.maxCells) {
      // A partial run's family weights are the weights of the cells that ran:
      // null-argument looked like 18 records in a three-cell trial and was
      // merged away, against 7,555 in its own cell. Consolidating on that
      // would be a confident answer built on a sample, so a trial stops here.
      log(`propose: trial of ${results.length} cells written to ${join(opts.outDir, "cells")}; no consolidation from a partial run`);
      return { trial: results.map((r) => r.cell.key) };
    }

    results.sort((a, b) => b.cell.errorCount - a.cell.errorCount);
    const pooled = poolDrafts(results);
    carryForward(db, pooled);
    log(`propose: ${pooled.size} families pooled; consolidating on the curate provider`);

    const consolidationFile = join(opts.outDir, "consolidation.json");
    let consolidation: Consolidation | null =
      !opts.fresh && existsSync(consolidationFile)
        ? (JSON.parse(readFileSync(consolidationFile, "utf8")) as Consolidation)
        : null;
    if (consolidation && validateConsolidation(consolidation, pooled).length > 0) consolidation = null;
    let issues: string[] = [];
    for (let round = 0; round < 2 && !consolidation; round++) {
      const res = await withTimeout(
        runProvider(consolidationPrompt([...pooled.values()], issues), { cwd }, providers, cfg, "curate"),
        watchdogBudgetMs(cfg, "curate")
      );
      issues = validateConsolidation(res.parsed, pooled);
      if (issues.length === 0) {
        consolidation = res.parsed as Consolidation;
        writeAtomic(consolidationFile, JSON.stringify(consolidation, null, 2));
      } else {
        log(`propose: consolidation round ${round + 1} rejected — ${issues.slice(0, 3).join("; ")}`);
      }
    }
    if (!consolidation) throw new Error(`consolidation still invalid after a repair round: ${issues.slice(0, 5).join("; ")}`);

    const { families, changes } = applyConsolidation(pooled, consolidation, opts.minErrors ?? CELL_MIN_ERRORS);
    const report = buildReport(db, build, results, families, changes);
    const taxonomyFile = join(opts.outDir, "tag-taxonomy.proposed.json");
    const reportFile = join(opts.outDir, "report.json");
    writeAtomic(
      taxonomyFile,
      `${JSON.stringify(families.map(({ tag, domain, criteria }) => ({ tag, domain, criteria })), null, 2)}\n`
    );
    writeAtomic(reportFile, JSON.stringify(report, null, 2));
    return { report, taxonomyFile, reportFile, failedCells: [] };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
