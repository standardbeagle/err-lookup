/**
 * GitHub repo metadata for RepoEntry (description, language, stars, default
 * branch). Unauthenticated is fine for one call per repo (§11.1); GITHUB_TOKEN
 * raises rate limits when present. Failure returns null and is logged by the
 * caller — missing metadata is left honest (null), never fabricated.
 */
export interface RepoMeta {
  description: string | null;
  language: string | null;
  stars: number;
  defaultBranch: string;
}

export function parseRepoMeta(json: unknown): RepoMeta | null {
  const o = json as {
    description?: unknown;
    language?: unknown;
    stargazers_count?: unknown;
    default_branch?: unknown;
  } | null;
  if (!o || typeof o !== "object") return null;
  return {
    description: typeof o.description === "string" ? o.description : null,
    language: typeof o.language === "string" ? o.language : null,
    stars: typeof o.stargazers_count === "number" ? o.stargazers_count : 0,
    defaultBranch: typeof o.default_branch === "string" ? o.default_branch : "main",
  };
}

export async function fetchRepoMeta(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<RepoMeta | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "errlookup-pipeline",
  };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return parseRepoMeta(await res.json());
  } catch {
    return null;
  }
}
