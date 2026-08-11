import { experimental_AstroContainer as AstroContainer } from "astro/container";
import type { ErrorEntry } from "@errlookup/schema";
import ErrorDetail from "../src/components/ErrorDetail.astro";
import { relatedFrom } from "../src/data/load.js";

/**
 * Error pages render on demand in the worker, so dist/ no longer contains
 * them. Tests assert against the same component render the worker produces,
 * via the container API — one render per record, memoized across suites.
 */
const rendered = new Map<string, string>();
let container: AstroContainer | null = null;

export async function renderErrorPage(e: ErrorEntry, all: ErrorEntry[]): Promise<string> {
  const key = `${e.repo}/${e.slug}`;
  const hit = rendered.get(key);
  if (hit) return hit;
  container ??= await AstroContainer.create();
  const html = await container.renderToString(ErrorDetail, {
    props: { error: e, repoFullName: e.repo, related: relatedFrom(all, e.slug) },
    request: new Request(`https://errors.standardbeagle.com/${e.repo}/${e.slug}/`),
  });
  rendered.set(key, html);
  return html;
}
