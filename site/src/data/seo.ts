/**
 * What a search result shows: the title and the one line under it.
 *
 * Pulled out of ErrorDetail because it is the only logic on that page whose
 * output a human judges in half a second, in a list, against nine competitors.
 * It deserves tests more than markup does.
 */

/** Format placeholders a message template carries into the title. */
const PLACEHOLDER = /\$?\{[^}]*\}|%[sdvqfwx]\b|%\{[^}]*\}|<[a-z_][a-z0-9_ ]*>/i;

/** Drop a trailing bracket that the removed placeholder was going to close. */
function closeDangling(head: string): string {
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const at = head.lastIndexOf(open);
    if (at !== -1 && head.indexOf(close, at) === -1) head = head.slice(0, at);
  }
  return head;
}

const TRAILING_JUNK = /[\s([{"'`:,–—-]+$/;

/**
 * The message as a title: placeholders removed, nothing left dangling.
 *
 * Half the corpus — 213,301 of 427,338 records on 2026-09-15 — has a message
 * holding a raw placeholder: `{process.ExitCode}`, `${tableName}`, `%s`, `{}`.
 * A searcher pastes the RESOLVED string ("exited during startup (code 1)"),
 * never the template, so the placeholder matches nothing they typed and reads
 * as broken output in a result list.
 *
 * Cutting at the first placeholder keeps the part a human recognises. The
 * exact template is not lost: the page's "Error message" block prints it
 * verbatim, which is what a pasted stack trace matches against.
 */
export function titleMessage(message: string): string {
  const hit = PLACEHOLDER.exec(message);
  if (!hit) return message;
  const head = closeDangling(message.slice(0, hit.index)).replace(TRAILING_JUNK, "").trim();
  // Keep the head when enough survives to name the error; otherwise drop just
  // the placeholders and keep the rest of the sentence.
  if (head.length >= 20) return head;
  const stripped = closeDangling(message.replace(new RegExp(PLACEHOLDER.source, "gi"), " "))
    .replace(/\s{2,}/g, " ")
    .replace(TRAILING_JUNK, "")
    .trim();
  return stripped || message;
}

/** A complete sentence cut on a word boundary — never mid-word. */
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max - 1);
  return `${s.slice(0, cut === -1 ? max : cut).replace(/[,;:.]$/, "")}…`;
}

/**
 * The line under the title: what it means, then what to do.
 *
 * The previous shape spent its opening words on "<code> in owner/repo:"
 * boilerplate and closed on a generic "See causes, fixes, and prevention.", so
 * the one line a searcher reads before deciding to click never said what to do
 * about the error.
 */
export function metaDescription(documentation: string, solutions: readonly string[], max = 160): string {
  const firstSentence = documentation.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? documentation;
  const firstSolution = solutions[0]?.trim();
  return truncateAtWord(firstSolution ? `${firstSentence} Fix: ${firstSolution}` : firstSentence, max);
}

/**
 * The short name for an error in a heading, breadcrumb or link.
 *
 * The same string that goes in the title also goes in the <h1>, the
 * BreadcrumbList, and every list row that links to the page — Google picks the
 * displayed title from among those, so a placeholder left in any one of them
 * undoes the title fix. Cut on a word boundary: a label ending mid-word reads
 * as truncated output rather than as a name.
 */
export function entryLabel(errorCode: string | null | undefined, errorMessage: string, max = 60): string {
  return errorCode ?? truncateAtWord(titleMessage(errorMessage), max);
}
