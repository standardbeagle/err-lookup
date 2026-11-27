/**
 * Search-engine site-ownership verification.
 *
 * Like the IndexNow key, these tokens prove control by being PUBLICLY readable
 * on the origin — there is nothing secret about them, so they are committed
 * rather than kept in the environment. A token in the environment would have to
 * reach the build on the publisher host, and a build that silently lost it
 * would un-verify the property without failing anything.
 *
 * `ERRLOOKUP_BING_TOKEN` overrides at build time, so a token can be tried
 * against a preview deployment before it is committed.
 */

/**
 * Bing Webmaster Tools "XML file" verification token, served at
 * /BingSiteAuth.xml. Empty until the property is claimed — see
 * docs/search-engine-setup.md for where it comes from.
 *
 * Why Bing at all: Googlebot has run ~40 requests/day on this host since it
 * withdrew on 2026-08-18, while bingbot runs 3,500-4,800/day and reached 25,887
 * distinct paths in the week to 2026-09-16. Bing is the crawler actually
 * reading the corpus, and without Webmaster Tools there is no impressions or
 * index-coverage signal from it at all.
 */
export const BING_SITE_AUTH_TOKEN = process.env.ERRLOOKUP_BING_TOKEN ?? "";

/** The document Bing expects at /BingSiteAuth.xml. */
export function bingSiteAuthXml(token: string): string {
  return `<?xml version="1.0"?>\n<users>\n  <user>${token}</user>\n</users>\n`;
}
