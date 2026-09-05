import type { ClusterCandidate } from "./collector.js";
import type { ClusterSample, InfoPageDraft } from "./prompts.js";

/**
 * Two gates between a drafted background article and a published one.
 *
 * `validateDraft` is deterministic and runs first, because most rejections are
 * shape problems a model should not be paid to notice: a two-sentence
 * "background", six identical causes, a library the family does not contain.
 * `reviewPrompt` is the adversarial second opinion, routed to the review
 * provider, and it is asked to check the claims a schema cannot — whether the
 * mechanism paragraph is actually supported by the records underneath it.
 *
 * An article that fails both rounds is not written. A family with no page is a
 * gap; a family with a wrong page is a citation the reader will trust.
 *
 * Guide slugs are deliberately not checked here: draftToEntry drops the ones
 * that name no guide and unions in what the deterministic matcher finds, so a
 * bad slug costs nothing and is no reason to throw away a sound article.
 */

const MIN_BACKGROUND_CHARS = 600;
const MIN_PARAGRAPH_CHARS = 120;
const REPO_MENTION = /\b[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\b/g;
const URL_MENTION = /\bhttps?:\/\//i;

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Shape and grounding checks that need no model. */
export function validateDraft(
  draft: InfoPageDraft,
  cluster: ClusterCandidate,
  samples: readonly ClusterSample[]
): string[] {
  const issues: string[] = [];
  const title = text(draft.title);
  const summary = text(draft.summary);
  const background = text(draft.background);

  if (title.length < 20 || title.length > 120) {
    issues.push(`title must be 20-120 characters, got ${title.length}`);
  }
  if (summary.length < 80 || summary.length > 500) {
    issues.push(`summary must be 80-500 characters, got ${summary.length}`);
  }

  const paragraphs = background.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    issues.push(`background must be at least 2 paragraphs, got ${paragraphs.length}`);
  }
  if (background.length < MIN_BACKGROUND_CHARS) {
    issues.push(`background must be at least ${MIN_BACKGROUND_CHARS} characters, got ${background.length}`);
  }
  const thin = paragraphs.filter((p) => p.length < MIN_PARAGRAPH_CHARS).length;
  if (thin > 0) {
    issues.push(`${thin} background paragraph(s) under ${MIN_PARAGRAPH_CHARS} characters — merge or expand them`);
  }

  const causes = draft.commonCauses ?? [];
  if (causes.length < 3 || causes.length > 8) {
    issues.push(`commonCauses must hold 3-8 items, got ${causes.length}`);
  }
  const causeNames = causes.map((c) => text(c?.cause).toLowerCase()).filter(Boolean);
  if (new Set(causeNames).size !== causes.length) {
    issues.push("commonCauses repeats a cause — each must name a distinct cause");
  }
  const shortDetails = causes.filter((c) => text(c?.detail).length < 40).length;
  if (shortDetails > 0) {
    issues.push(`${shortDetails} commonCauses detail(s) under 40 characters — say what actually goes wrong`);
  }

  const fixes = (draft.fixes ?? []).map(text).filter(Boolean);
  if (fixes.length < 2 || fixes.length > 6) {
    issues.push(`fixes must hold 2-6 items, got ${fixes.length}`);
  }
  if (fixes.some((f) => f.length < 20)) {
    issues.push("a fix is too short to act on — each must be a concrete remediation");
  }

  const prose = [title, summary, background, ...causes.map((c) => `${text(c?.cause)} ${text(c?.detail)}`), ...fixes].join("\n");
  if (URL_MENTION.test(prose)) {
    issues.push("the article contains a URL — the site renders its own links");
  }

  // A family article may only name libraries the family actually appears in.
  // Inventing a library is the failure mode a reader cannot detect and the one
  // that makes the whole corpus untrustworthy.
  const allowed = new Set(samples.map((s) => s.repo.toLowerCase()));
  const invented = new Set<string>();
  for (const m of prose.matchAll(REPO_MENTION)) {
    const mention = m[0];
    // Only owner/name shapes that look like a GitHub coordinate, not "and/or"
    // or a path fragment inside a quoted message.
    if (!/^[A-Za-z0-9][\w.-]{1,38}\/[A-Za-z0-9][\w.-]{0,99}$/.test(mention)) continue;
    if (!allowed.has(mention.toLowerCase())) invented.add(mention);
  }
  if (invented.size > 0) {
    issues.push(
      `names libraries the family does not contain: ${[...invented].slice(0, 5).join(", ")} — write only about the libraries listed`
    );
  }

  if (cluster.kind === "code" && !`${title} ${summary}`.toLowerCase().includes(cluster.value.toLowerCase())) {
    issues.push(`title or summary must contain the error code "${cluster.value}" — it is what readers search for`);
  }

  return issues;
}

/** What the reviewer returns. `revision` is optional: issues alone earn a retry. */
export interface DraftReview {
  verdict?: string;
  issues?: string[];
  revision?: InfoPageDraft;
}

export function reviewPrompt(
  cluster: ClusterCandidate,
  samples: readonly ClusterSample[],
  draft: InfoPageDraft
): string {
  const records = samples
    .map(
      (s, i) =>
        `[${i}] ${s.repo}: "${s.message}"` +
        (s.documentation ? `\n  documentation: ${s.documentation}` : "") +
        (s.solutions.length ? `\n  solutions: ${s.solutions.join(" | ")}` : "")
    )
    .join("\n");

  return `You are reviewing a background article before it is published on ErrLookup. You are
the last check between a wrong claim and a reader who will trust it.

FAMILY: ${cluster.value} (${cluster.kind}) — ${cluster.errorCount} records across ${cluster.repoCount} repositories.

THE RECORDS THE ARTICLE MUST REST ON:
${records}

THE DRAFT:
${JSON.stringify(draft, null, 2)}

Check, in this order:
1. Every factual claim in background and commonCauses is supported by the records above.
   A claim the records do not support is the failure that matters most.
2. No library is named that does not appear in the records.
3. The mechanism described is the mechanism the records describe, not a plausible
   substitute from your own knowledge of the ecosystem.
4. Where the records disagree, the draft says the behaviour is library-specific rather
   than picking one library's version and presenting it as the family's.
5. commonCauses are actual causes, not restatements of the error message.

Return ONLY JSON:
{"verdict":"accept"} when the draft is publishable as written, or
{"verdict":"revise","issues":["..."],"revision":{ ...the corrected draft, same fields... }}

Revise conservatively: keep every supported sentence, change only what is wrong. If a
claim cannot be supported, cut it rather than softening it.`;
}
