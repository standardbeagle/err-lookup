import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ErrorType } from "@errlookup/schema";

/**
 * Stable id per §3.1: sha256(repo + errorCode|normalizedMessage + filePath).slice(0,16).
 * Deterministic so the same error at the same location maps to the same id across runs.
 */
export function computeErrorId(args: {
  repo: string;
  errorCode: string | null;
  errorMessage: string;
  filePath: string;
}): string {
  const key = args.errorCode ?? args.errorMessage;
  const blob = `${args.repo}\u0001${key}\u0001${args.filePath}`;
  return createHash("sha256").update(blob).digest("hex").slice(0, 16);
}

/**
 * A discovered `code` as a string, or null when it is not a code at all.
 * Numbers are real codes (HTTP status, errno) and keep their value; objects,
 * arrays and booleans are noise from a model that filled the field to fill it.
 */
export function normalizeErrorCode(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim().length > 0 ? raw : null;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

/** Slug length cap. Trimmed at a word boundary, so a slug never ends mid-word. */
const SLUG_MAX = 60;

/** Lowercase kebab of the ASCII-alphanumeric runs in `value`, capped at whole words. */
function kebab(value: string, max = SLUG_MAX): string {
  const words = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= max) return words;
  // Cut at the last hyphen inside the cap; a hard slice would truncate
  // mid-word and make two unrelated messages share a prefix.
  const cut = words.slice(0, max + 1);
  const boundary = cut.lastIndexOf("-");
  return boundary > 0 ? cut.slice(0, boundary) : words.slice(0, max);
}

/** The file's basename without extension — the last resort for a slug. */
function fileStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  return kebab(base.replace(/\.[^.]+$/, ""));
}

/**
 * URL-safe slug, unique within a repo: the errorCode if present, else the
 * message, kebabed and capped at a word boundary.
 *
 * A message with no ASCII alphanumerics kebabs to nothing — every CJK message
 * does — and used to become the literal "error", which is the worst URL we
 * publish: it carries no keyword, and a repo with several of them ends up with
 * /error/, /error-39bdc1/, /error-c231f2/. Those fall back to the source file's
 * name, which at least says where the throw lives. "error" survives only when
 * the file name is unusable too.
 */
export function deriveSlug(errorCode: string | null, errorMessage: string, filePath = ""): string {
  const code = errorCode === null ? "" : kebab(errorCode);
  // A purely numeric code is a fine identifier and a terrible URL. HTTP
  // statuses and errno values kebab to "404", "16", "32001" — no keyword for a
  // search result to match, and every other 404 in the repo then collides into
  // 404-68ab46. Pair the number with the message so the slug says what the
  // error IS. Measured on typecho 2026-09-11 (a repo whose errors carry numeric
  // codes): 14 of its 43 fresh slugs were bare numbers or number-plus-hex.
  if (code !== "" && !/[a-z]/.test(code)) {
    // Only the words the code does not already carry, so a message that just
    // restates the number ("500") does not produce 500-500.
    const seen = new Set(code.split("-"));
    const added = kebab(errorMessage).split("-").filter((w) => w !== "" && !seen.has(w));
    if (added.length > 0) return kebab(`${code}-${added.join("-")}`);
    // Numeric code AND nothing sluggable in the message — a CJK message on a
    // numeric-code repo hits both at once. The file at least says where.
    // A one- or two-letter stem ("a", "db") is no more use than the number.
    const stem = fileStem(filePath);
    if (stem.length >= 3 && !seen.has(stem)) return kebab(`${code}-${stem}`);
  }
  return code || kebab(errorMessage) || fileStem(filePath) || "error";
}

/**
 * A second, more specific slug to try when `deriveSlug` collides — reached
 * before the hex-suffix fallback, which produces unreadable URLs like
 * err-bad-response-3f2a1c (11.5% of a 2026-09-09 sample carried one).
 *
 * The two collisions worth naming: one errorCode thrown from several files
 * (deriveSlug never looks past the code), and one message thrown from several
 * files. Both are distinguished by adding what the primary ignored — the
 * message for a code slug, the file for a message slug.
 */
export function deriveSlugAlternative(
  errorCode: string | null,
  errorMessage: string,
  filePath = ""
): string | null {
  const primary = deriveSlug(errorCode, errorMessage, filePath);
  const detail = errorCode ? kebab(errorMessage) : fileStem(filePath);
  if (!detail) return null;
  // Only the words the primary does not already carry: a code and its message
  // usually restate each other, and err-invalid-state-invalid-state-in-lexer
  // is not a URL worth publishing.
  const seen = new Set(primary.split("-"));
  const added = detail.split("-").filter((w) => !seen.has(w));
  if (added.length === 0) return null;
  const combined = kebab(`${primary}-${added.join("-")}`);
  return combined === primary ? null : combined;
}

/** Normalize a discovered error type string into the schema enum (best-effort). */
export function normalizeErrorType(raw: string | null | undefined): ErrorType {
  const t = (raw ?? "").toLowerCase();
  if (t === "panic") return "panic";
  if (t === "http") return "http";
  if (t === "validation") return "validation";
  if (t === "console") return "console";
  if (t === "error_code" || t === "error-code" || t === "code") return "error_code";
  return "exception";
}
