/**
 * Derive a `messagePattern` regex (as a string) from an errorMessage (§4.3).
 *
 * - Escape regex metacharacters in literal parts.
 * - Replace template placeholders (${x}, {x}, {}, %s, %d, %(name)s, backtick
 *   interpolations) with non-greedy (.+?) capture groups.
 * - Replace LLM-flagged variable literals (paths, ports, hostnames) with groups.
 * - No ^/$ anchors (real-world messages carry prefixes/suffixes).
 *
 * The derived pattern is validated to compile as a JS RegExp and to be RE2-safe
 * (no backreferences, no nested quantifiers over groups). ReDoS-prone patterns
 * fall back to an escaped-literal pattern.
 */

const PLACEHOLDER = "\u0001";

/** Replace template placeholders in `s` with a placeholder token. */
function replacePlaceholders(s: string, variableLiterals: string[] = []): string {
  let out = s;
  // backtick / JS template interpolation: ${name}
  out = out.replace(/\$\{[^}]*\}/g, PLACEHOLDER);
  // Python named: %(name)s
  out = out.replace(/%\([^)]*\)[sdifge]/g, PLACEHOLDER);
  // C-style: %s %d %i %j %f %v (single %% stays literal)
  out = out.replace(/%[sdifjv]/g, PLACEHOLDER);
  // Brace placeholders: {0} {name} {}
  out = out.replace(/\{[^}]*\}/g, PLACEHOLDER);
  // LLM-flagged variable literals (paths, ports, hostnames, hex, numbers-in-quotes)
  for (const lit of variableLiterals) {
    if (lit && lit.length > 1) {
      try {
        out = out.replace(new RegExp(escapeRegex(lit), "g"), PLACEHOLDER);
      } catch {
        // skip un-usable literal
      }
    }
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the derived pattern string from a placeholder-marked string. */
function buildPattern(marked: string): string {
  // Escape literal parts (the placeholder char is not a metachar, survives).
  const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Substitute placeholder tokens with non-greedy groups.
  return escaped.split(PLACEHOLDER).join("(.+?)");
}

/** True if `pattern` is RE2-safe and not obviously ReDoS-prone (§4.3). */
export function isRe2Safe(pattern: string): boolean {
  if (pattern.length > 500) return false;
  // Backreferences (\1 .. \9) are unsupported by RE2.
  if (/\\[1-9]/.test(pattern)) return false;
  // Nested quantifiers over a group: e.g. (...)+?, (.+?)+, (a{2,})+
  // Detect a `)` followed by a quantifier, with a quantifier also inside the group.
  if (/\([^()]*[+*?][^()]*\)[+*?{]/.test(pattern)) return false;
  // Overlapping alternation with repeated prefixes is hard to detect cheaply; skip.
  return true;
}

export interface DerivedPattern {
  pattern: string;
  /** "derived" when derived+safe; "literal" when fallen back to escaped literal. */
  source: "derived" | "literal";
}

/**
 * Derive a messagePattern. Falls back to an escaped literal when the derived
 * pattern is ReDoS-prone or fails to compile.
 */
export function deriveMessagePattern(
  errorMessage: string,
  variableLiterals: string[] = []
): DerivedPattern {
  if (!errorMessage) return { pattern: "(.+?)", source: "literal" };
  const marked = replacePlaceholders(errorMessage, variableLiterals);
  const derived = buildPattern(marked);
  try {
    // Must compile as a JS RegExp.
    // eslint-disable-next-line no-new
    new RegExp(derived);
  } catch {
    return { pattern: escapeRegex(errorMessage), source: "literal" };
  }
  if (!isRe2Safe(derived)) {
    return { pattern: escapeRegex(errorMessage), source: "literal" };
  }
  return { pattern: derived, source: "derived" };
}
