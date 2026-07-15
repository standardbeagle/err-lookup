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
 * URL-safe slug, unique within a repo. From errorCode if present, else first 50
 * chars of the message. Lowercased, non-alphanumerics → hyphens, trimmed.
 */
export function deriveSlug(errorCode: string | null, errorMessage: string): string {
  const source = (errorCode ?? errorMessage).slice(0, 50).toLowerCase();
  const kebab = source
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab || "error";
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
