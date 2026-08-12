import { getIndex, type IndexError } from "./load.js";
import { GUIDES, matchesGuide, type GuideDef } from "@errlookup/schema";

// The registry itself lives in @errlookup/schema so the site and the pipeline
// (info-page collector) cannot drift on which guides exist. This module keeps
// the site-only helper that needs the search index, and re-exports the rest so
// page imports stay unchanged.
export { GUIDES, guideBySlug, matchesGuide, guidesFor, guideHref, type GuideDef } from "@errlookup/schema";

/** All matching records for a guide's occurrences section, from the search index. */
export function guideErrors(g: GuideDef): IndexError[] {
  return getIndex().errors.filter((e) => matchesGuide(g, e.code, e.msg));
}
