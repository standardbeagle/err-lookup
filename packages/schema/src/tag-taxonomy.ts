/**
 * The canonical background-family taxonomy: the closed list of families a
 * record's `backgroundTag` is allowed to name.
 *
 * `tags.ts` folds spelling and hand-written synonyms, and that was enough to
 * keep a name stable once it existed. It never bounded how many names could
 * exist: the enrichment prompt asks the model to coin a family, so the corpus
 * grew 56,960 distinct families over 496,100 records, 37,280 of them used
 * exactly once, while the top 250 covered 63% of the records. Sprawl on that
 * scale is not a spelling problem — `unsupported-operation`,
 * `operation-not-supported`, `method-not-implemented` and
 * `feature-not-implemented` are four names for one article, and no rule over
 * their characters says so.
 *
 * So the vocabulary stops being derived and becomes declared. A proposal is
 * mapped onto one of these families by a typed classifier
 * (`phase/tag-classify.ts`), or onto nothing at all; a family that is not in
 * this file cannot be published. Growth is a promotion: a proposal that keeps
 * arriving and fits nothing here shows up in `errlookup tags candidates`, and
 * someone adds it to `tag-taxonomy.json` with a rubric.
 *
 * Editing rules, in order of how often they are broken:
 *
 *   1. One line of `criteria` per family, written for a classifier that sees
 *      only this line and the error text. Say what belongs, then name the
 *      neighbouring family it is NOT. A rubric that describes the name back
 *      to itself ("invalid config value: the config value is invalid") makes
 *      the choice worse than no rubric.
 *   2. Every family must have a distinct `tagKey`. Two names that fold to the
 *      same key are the same family to the resolver, and the second one would
 *      be unreachable. `tag-taxonomy.test.ts` fails the build on this.
 *   3. When merging existing families, keep the name carrying the most
 *      records. It is the one whose article already holds the internal links,
 *      and renaming loses them for nothing.
 *   4. At most FAMILY_CHOICE_LIMIT entries. The whole list is offered as one
 *      Choice question so every classification sees every option; the model's
 *      hard cap is 255 options and one slot is spent on "none of these".
 */

import taxonomy from "./tag-taxonomy.json" with { type: "json" };

/** A family a record's `backgroundTag` may name, with the rubric that selects it. */
export interface CanonicalFamily {
  /** Kebab-case family name, exactly as it is stored and published. */
  tag: string;
  /**
   * Which part of the stack the family belongs to. Groups the list for review
   * and for proposing changes; it is not sent to the classifier, which judges
   * every family against every other regardless of domain.
   */
  domain: string;
  /** One line telling a classifier what belongs here and what does not. */
  criteria: string;
}

/**
 * Options a single Choice question may carry, less the "none of these" slot.
 * Growing past this means the taxonomy no longer fits one decision and has to
 * be split into a two-stage (domain, then family) classification.
 */
export const FAMILY_CHOICE_LIMIT = 254;

/**
 * The families, as data. They live in `tag-taxonomy.json` rather than in this
 * file because `errlookup tags propose` writes its proposal in the same shape:
 * adopting a proposal is replacing a file and reading the diff, not
 * transcribing JSON into TypeScript by hand.
 */
export const CANONICAL_FAMILIES: readonly CanonicalFamily[] = taxonomy;

/** Every canonical family name, for membership checks on the write path. */
export const CANONICAL_TAGS: ReadonlySet<string> = new Set(CANONICAL_FAMILIES.map((f) => f.tag));

/** Whether a tag may be stored as a record's background family. */
export function isCanonicalFamily(tag: string | null | undefined): boolean {
  return tag != null && CANONICAL_TAGS.has(tag);
}

/** Rubric for one family, or null when the name is not canonical. */
export function familyCriteria(tag: string): string | null {
  return CANONICAL_FAMILIES.find((f) => f.tag === tag)?.criteria ?? null;
}
