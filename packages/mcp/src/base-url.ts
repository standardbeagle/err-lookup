/** Canonical public site origin. Single source of truth for URLs the MCP emits. */
export const DEFAULT_BASE_URL = "https://errors.standardbeagle.com";

export function siteBaseUrl(
  // no `process` in edge runtimes (Cloudflare Workers) — fall back cleanly
  env: NodeJS.ProcessEnv = typeof process !== "undefined" ? process.env : {}
): string {
  return (env.ERRLOOKUP_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function siteErrorUrl(repo: string, slug: string): string {
  const [owner, name] = repo.split("/");
  return `${siteBaseUrl()}/${owner}/${name}/${slug}/`;
}
