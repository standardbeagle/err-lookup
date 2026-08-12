import type { ErrorEntry, InfoPageIndexEntry } from "@errlookup/schema";

/**
 * Per-request data access for on-demand routes. In the deployed worker the
 * ASSETS binding serves this deployment's own static files without leaving the
 * data center; under `astro dev` there is no binding, so the same files come
 * from the dev server that is already serving public/ — an environment
 * difference, not a data fallback: both read the identical dataset.
 */
export interface RuntimeLocals {
  runtime?: { env?: { ASSETS?: { fetch: (req: Request | string) => Promise<Response> } } };
}

export async function fetchDataJson<T>(locals: RuntimeLocals, origin: string, relPath: string): Promise<T | null> {
  const href = new URL(`/data/${relPath}`, origin).href;
  const assets = locals.runtime?.env?.ASSETS;
  const res = assets ? await assets.fetch(href) : await fetch(href);
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Info-page hub rows; a dataset from before the collector first ran has none. */
export async function fetchInfoIndex(locals: RuntimeLocals, origin: string): Promise<InfoPageIndexEntry[]> {
  return (await fetchDataJson<InfoPageIndexEntry[]>(locals, origin, "info/index.json")) ?? [];
}

/**
 * The background article covering this error's family, if one is published.
 * Matches the record's backgroundTag first (tag-cluster pages use the tag as
 * their slug), then the slugified error code (code-cluster pages).
 */
export function findBackgroundArticle(
  index: InfoPageIndexEntry[],
  e: Pick<ErrorEntry, "backgroundTag" | "errorCode">
): InfoPageIndexEntry | null {
  const bySlug = new Map(index.map((p) => [p.slug, p]));
  const codeSlug = e.errorCode
    ? e.errorCode.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : null;
  for (const slug of [e.backgroundTag, codeSlug]) {
    const hit = slug ? bySlug.get(slug) : undefined;
    if (hit) return hit;
  }
  return null;
}

export async function fetchRepoErrors(
  locals: RuntimeLocals,
  origin: string,
  repoFullName: string
): Promise<ErrorEntry[] | null> {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  return fetchDataJson<ErrorEntry[]>(locals, origin, `repos/${owner}/${name}.json`);
}
