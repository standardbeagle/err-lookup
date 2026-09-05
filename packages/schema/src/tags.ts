/**
 * Background-family tags: the vocabulary that decides which error pages share
 * a background article.
 *
 * The field started life as free text — "ONE lowercase kebab-case tag naming
 * the cross-library error FAMILY" — with no list of families to choose from.
 * The model coined a fresh name per batch, so a 309,555-record corpus grew
 * 55,568 distinct tags, two thirds of them used exactly once, and only 7.6% of
 * records landed on a family that had an article. A family name is only useful
 * if the next record reaches the same one.
 *
 * Two mechanisms keep it stable, and they are deliberately different:
 *
 *   - `tagKey` folds spelling, not meaning: abbreviations, plurals, filler
 *     words, token order. "missing-env-var", "missing-environment-variables"
 *     and "env-var-missing" are one family; nothing else is merged by rule.
 *   - `TAG_ALIASES` folds meaning, by hand. Every entry is a decision someone
 *     made and can read back, which is the only honest way to say that
 *     "missing-required-field" and "missing-required-parameter" are the same
 *     article.
 */

/** Kebab-case tag shape (mirrors Tag in error.ts). */
const TAG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Names too generic to carry a background article. A page called "error"
 * describes nothing and collects everything — the first collector run spent
 * its budget on exactly that.
 */
export const GENERIC_FAMILIES = new Set([
  "error",
  "errors",
  "exception",
  "exceptions",
  "baseexception",
  "throwable",
  "runtimeerror",
  "runtimeexception",
  "failure",
  "failures",
  "unknown",
  "generic",
  "misc",
  "other",
]);

/**
 * Tokens that carry no family meaning on their own. Dropping them makes
 * "connection-refused" and "connection-refused-error" the same key. They are
 * only dropped when something survives — "error" alone stays generic and is
 * rejected by `normalizeTag`, not silently emptied.
 */
const FILLER = new Set([
  "a", "an", "the", "is", "was", "be", "been", "to", "of", "for", "in", "on",
  "at", "by", "with", "when", "while", "during", "from",
  "error", "err", "exception", "failure", "fault", "problem", "issue",
]);

/** Abbreviation → written-out form. Spelling only; nothing here changes meaning. */
const EXPANSIONS: Record<string, string> = {
  arg: "argument",
  args: "argument",
  param: "parameter",
  params: "parameter",
  prop: "property",
  props: "property",
  attr: "attribute",
  attrs: "attribute",
  env: "environment",
  cfg: "configuration",
  config: "configuration",
  auth: "authentication",
  authz: "authorization",
  db: "database",
  cert: "certificate",
  certs: "certificate",
  dir: "directory",
  dirs: "directory",
  repo: "repository",
  req: "request",
  res: "response",
  resp: "response",
  msg: "message",
  val: "value",
  num: "number",
  str: "string",
  obj: "object",
  fn: "function",
  func: "function",
  var: "variable",
  vars: "variable",
  conn: "connection",
  dep: "dependency",
  deps: "dependency",
  perm: "permission",
  perms: "permission",
  spec: "specification",
  init: "initialization",
  impl: "implementation",
  ref: "reference",
  refs: "reference",
  addr: "address",
  len: "length",
  idx: "index",
  admin: "administrator",
  ctx: "context",
};

/**
 * Hand-maintained meaning-level merges: alias → canonical family.
 *
 * Add an entry only when the two names would produce the same article. The
 * three "missing-required-*" forms were 3,368 records split across three
 * pages, each diluting the others' internal links.
 */
export const TAG_ALIASES: Record<string, string> = {
  "missing-required-field": "missing-required-argument",
  "missing-required-parameter": "missing-required-argument",
  "missing-required-property": "missing-required-argument",
  "missing-argument": "missing-required-argument",
  "required-argument-missing": "missing-required-argument",
  "invalid-argument-type": "invalid-argument-value",
  "invalid-parameter-value": "invalid-argument-value",
  "invalid-field-value": "invalid-argument-value",
  "wrong-argument-type": "invalid-argument-value",
  "config-validation-failed": "invalid-config-value",
  "configuration-validation-failed": "invalid-config-value",
  "invalid-configuration-value": "invalid-config-value",
  "missing-environment-variable": "missing-env-var",
  "environment-variable-missing": "missing-env-var",
  "unset-environment-variable": "missing-env-var",
  "file-does-not-exist": "file-not-found",
  "no-such-file": "file-not-found",
  "path-not-found": "file-not-found",
  "resource-does-not-exist": "resource-not-found",
  "not-found": "resource-not-found",
  "schema-validation-error": "schema-validation-failed",
  "invalid-schema": "schema-validation-failed",
  "json-schema-validation-failed": "schema-validation-failed",
  "unsupported-value": "invalid-enum-value",
  "invalid-option-value": "invalid-enum-value",
  "unknown-enum-value": "invalid-enum-value",
};

/** Crude singularization: enough for tag tokens, no dictionary. */
function singular(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("ches") || token.endsWith("shes"))) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Normalize a proposed tag to kebab shape, or null when it is unusable.
 * Auxiliary field: a malformed or generic value is dropped, never a reason to
 * reject the whole record.
 */
export function normalizeTag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tag = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!TAG_RE.test(tag) || GENERIC_FAMILIES.has(tag)) return null;
  return TAG_ALIASES[tag] ?? tag;
}

/** Spelling identity before any hand-maintained merge is considered. */
function spellingKey(tag: string): string {
  const tokens = tag
    .split("-")
    .map((t) => EXPANSIONS[t] ?? t)
    .map(singular)
    .filter((t) => t.length > 0 && !FILLER.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

/**
 * Alias groups live at the key level, not the string level.
 *
 * Writing the alias only against the exact spelling would leave its own
 * variants behind: "missing-required-field" would merge into
 * "missing-required-argument" while "required-field-missing" — the same words
 * in a different order — kept its own family and its own article. Mapping the
 * alias's key to the target's key makes every spelling of the alias follow it.
 */
const ALIAS_KEYS = new Map<string, string>(
  Object.entries(TAG_ALIASES).map(([alias, target]) => [spellingKey(alias), spellingKey(target)])
);

/**
 * Spelling-independent identity of a family name. Two tags with the same key
 * name the same family however they were written; an empty key means the tag
 * carried nothing but filler.
 */
export function tagKey(tag: string): string {
  const key = spellingKey(tag);
  return ALIAS_KEYS.get(key) ?? key;
}

/** The name a tag settles on before any vocabulary is consulted. */
export function canonicalName(tag: string): string {
  return TAG_ALIASES[tag] ?? tag;
}

/** A family in the published vocabulary, with the article that covers it. */
export interface TagFamily {
  tag: string;
  errorCount: number;
  repoCount: number;
  /** Slug of the background article covering this family, when one exists. */
  infoSlug: string | null;
}

/**
 * Index a vocabulary for resolution. Where several existing tags share a key,
 * the one with the most records wins — the article that already has the
 * internal links is the one worth growing.
 */
export function buildTagIndex(vocabulary: readonly TagFamily[]): Map<string, string> {
  const best = new Map<string, TagFamily>();
  for (const f of vocabulary) {
    const key = tagKey(f.tag);
    if (!key) continue;
    const cur = best.get(key);
    if (!cur || f.errorCount > cur.errorCount || (f.errorCount === cur.errorCount && f.tag < cur.tag)) {
      best.set(key, f);
    }
  }
  // The winner's canonical name, not its raw spelling: when the largest member
  // of a group is itself an alias, the alias target is what everything folds
  // onto. A hand-written merge outranks a record count on purpose — the count
  // is why the group exists, the alias is the decision about what to call it.
  return new Map([...best].map(([key, f]) => [key, canonicalName(f.tag)]));
}

/**
 * Resolve a proposed tag against an existing vocabulary index.
 *
 * Returns the established family when the proposal is the same family spelled
 * differently, the normalized proposal when it is genuinely new, and null when
 * it is unusable. New families are allowed on purpose: a closed vocabulary
 * would freeze the corpus at whatever the first thousand repos happened to
 * throw.
 */
export function resolveTag(raw: string | null | undefined, index: Map<string, string>): string | null {
  const tag = normalizeTag(raw);
  if (!tag) return null;
  const key = tagKey(tag);
  if (!key) return null;
  return index.get(key) ?? canonicalName(tag);
}
