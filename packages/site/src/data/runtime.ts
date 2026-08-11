import type { ErrorEntry } from "@errlookup/schema";

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

export async function fetchRepoErrors(
  locals: RuntimeLocals,
  origin: string,
  repoFullName: string
): Promise<ErrorEntry[] | null> {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return null;
  return fetchDataJson<ErrorEntry[]>(locals, origin, `repos/${owner}/${name}.json`);
}
