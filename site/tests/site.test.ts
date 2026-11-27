import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDES, guidesFor } from "../src/data/guides.js";
import { posts } from "../src/data/blog.js";
import { truncateAtWord } from "../src/data/seo.js";
import { indexableSlugs, canonicalBySlug } from "@errlookup/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const dist = resolve(siteRoot, "dist");
const publicData = resolve(siteRoot, "public", "data");

import type { ErrorEntry } from "@errlookup/schema";
import { renderErrorPage } from "./render-error-page.js";
import { missingErrorPage } from "../src/data/load.js";

function fullErrorsByRepo(): Map<string, ErrorEntry[]> {
  const repos = JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as { repo: string }[];
  const out = new Map<string, ErrorEntry[]>();
  for (const r of repos) {
    const [owner, name] = r.repo.split("/");
    out.set(r.repo, JSON.parse(readFileSync(resolve(publicData, `repos/${owner}/${name}.json`), "utf8")));
  }
  return out;
}

/** Render every fixture error page the way the worker would, keyed repo/slug. */
async function renderedErrorPages(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [repo, all] of fullErrorsByRepo()) {
    for (const e of all) out.set(`${repo}/${e.slug}`, await renderErrorPage(e, all));
  }
  return out;
}

function readErrorRecords(): {
  repo: string;
  slug: string;
  errorMessage: string;
  errorCode: string | null;
  id: string;
  analyzedAt: string;
  contentChangedAt: string | null;
}[] {
  const repos = JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as { repo: string }[];
  const out: ReturnType<typeof readErrorRecords> = [];
  for (const r of repos) {
    const [owner, name] = r.repo.split("/");
    const errors = JSON.parse(readFileSync(resolve(publicData, `repos/${owner}/${name}.json`), "utf8"));
    for (const e of errors)
      out.push({
        repo: r.repo,
        slug: e.slug,
        errorMessage: e.errorMessage,
        errorCode: e.errorCode ?? null,
        id: e.id,
        analyzedAt: e.analyzedAt,
        contentChangedAt: e.contentChangedAt ?? null,
      });
  }
  return out;
}

beforeAll(() => {
  // tests/global-setup.ts builds the site once for the whole suite; every
  // file here only reads dist/.
});

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full));
    else if (ent.endsWith(".html")) out.push(full);
  }
  return out;
}

function hrefToDistPath(href: string): string | null {
  if (!href.startsWith("/")) return null;
  if (href.startsWith("/data/")) return null; // static JSON asset, not an HTML page
  if (href.startsWith("/api/")) return null; // served by the worker, no dist file
  // Error detail pages are on-demand worker routes; validate against the
  // dataset instead of dist.
  if (VALID_ERROR_HREFS.has(href.split("#")[0]!.split("?")[0]!)) return null;
  const clean = href.split("#")[0]!.split("?")[0]!;
  const rel = clean.replace(/^\//, "");
  // Static assets (favicon, media, etc.) must exist in dist as plain files.
  if (/\.(svg|ico|png|jpe?g|gif|webp|json|xml|txt|css|js|map|mp4|webm|pdf)$/.test(clean)) {
    return resolve(dist, rel);
  }
  if (rel === "") return resolve(dist, "index.html");
  return resolve(dist, rel, "index.html");
}

const VALID_ERROR_HREFS = new Set(
  readErrorRecords().map((e) => `/${e.repo}/${e.slug}/`)
);

describe("site build (§8.3)", () => {
  it("ships error pages as on-demand worker routes, not dist files", () => {
    // The corpus outgrew one-static-page-per-error (Pages file cap + build
    // clock); the worker renders them from /data shards instead.
    expect(existsSync(resolve(dist, "_worker.js")), "dist/_worker.js missing").toBe(true);
    const routes = JSON.parse(readFileSync(resolve(dist, "_routes.json"), "utf8"));
    expect(routes.include).toContain("/*"); // one splat: wrangler rejects overlapping include rules
    expect(routes.include.length + routes.exclude.length, "over Cloudflare's 100-rule cap").toBeLessThanOrEqual(100);
    // The retired per-repo sitemaps answer 410 from an on-demand route under
    // /sitemaps/<owner>/<repo>.xml; excluding /sitemaps/* would turn them
    // back into the static 404s that route exists to end. The prerendered
    // shards beside them are excluded by their own pattern: a prerendered
    // path routed to the worker is served from ASSETS before middleware runs,
    // so it is invisible to Analytics Engine either way and the invocation
    // buys nothing (0 AE rows in 3 days for any of them, 2026-09-22).
    expect(routes.exclude).not.toContain("/sitemaps/*");
    for (const prerendered of ["/robots.txt", "/sitemap-index.xml", "/sitemaps/urls-*", "/repos/*"]) {
      expect(routes.exclude, `${prerendered} is prerendered; the worker cannot observe it`).toContain(prerendered);
    }
    for (const e of readErrorRecords()) {
      const p = resolve(dist, e.repo, e.slug, "index.html");
      expect(existsSync(p), `${p} should be on-demand, not prerendered`).toBe(false);
    }
  });

  it("repo lists link only to indexable pages", async () => {
    // Googlebot runs ~50 requests a day on this host after the August
    // withdrawal. A link to a page we render noindex spends one of them on a
    // page we have asked it not to index, and splits link equity with the
    // pages we do want. Unindexable records stay reachable through search.
    const repos = JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as { repo: string }[];
    for (const r of repos) {
      const file = resolve(dist, r.repo, "index.html");
      if (!existsSync(file)) continue;
      const html = readFileSync(file, "utf8");
      const all = fullErrorsByRepo().get(r.repo) ?? [];
      const linkable = new Set(indexableSlugs(all));
      for (const e of all) {
        if (linkable.has(e.slug)) continue;
        expect(html, `${r.repo} links noindexed ${e.slug}`).not.toContain(`/${r.repo}/${e.slug}/"`);
      }
    }
  });

  it("emits exactly one canonical per page, pointing at the group's winner", async () => {
    // Base renders a canonical from its own prop and ErrorDetail used to render
    // a second one. While both said the same thing the duplication was
    // harmless; the moment a duplicate could canonicalise to a sibling they
    // disagreed, and a page with two conflicting canonicals has none as far as
    // Google is concerned — strictly worse than the noindex it replaced.
    const pages = await renderedErrorPages();
    for (const [key, html] of pages) {
      const tags = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]!);
      expect(tags, `${key} should have exactly one canonical`).toHaveLength(1);
      const [repo, slug] = [key.split("/").slice(0, 2).join("/"), key.split("/")[2]!];
      const all = fullErrorsByRepo().get(repo)!;
      const winner = canonicalBySlug(all).get(slug) ?? slug;
      expect(tags[0], `${key} canonical should point at ${winner}`).toBe(
        `https://errors.standardbeagle.com/${repo}/${winner}/`
      );
    }
  });

  it("each error page contains the exact error message + JSON twin link", async () => {
    for (const [key, html] of await renderedErrorPages()) {
      const [repo, slug] = [key.split("/").slice(0, 2).join("/"), key.split("/")[2]!];
      const e = fullErrorsByRepo().get(repo)!.find((x) => x.slug === slug)!;
      expect(html).toContain(e.errorMessage);
      expect(html).toContain(`/api/errors/${e.id}`);
    }
  });

  it("JSON-LD on error pages parses and carries TechArticle + FAQPage", async () => {
    const pages = await renderedErrorPages();
    for (const e of readErrorRecords()) {
      const html = pages.get(`${e.repo}/${e.slug}`)!;
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(m, `no JSON-LD on ${e.slug}`).not.toBeNull();
      const ld = JSON.parse(m![1]);
      const types = ld["@graph"].map((g: { "@type": string }) => g["@type"]);
      expect(types).toContain("TechArticle");
      expect(types).toContain("FAQPage");
      // Article-family rich results are ineligible without dates, author, and
      // publisher — the node parses but earns nothing in the SERP.
      const article = ld["@graph"].find((g: { "@type": string }) => g["@type"] === "TechArticle");
      // The date a reader (and Google) is told the page changed is the date
      // its content changed, not the date it was last re-analyzed.
      const changed = e.contentChangedAt ?? e.analyzedAt;
      expect(article.datePublished).toBe(changed);
      expect(article.dateModified).toBe(changed);
      expect(article.author?.name).toBe("Standard Beagle");
      expect(article.publisher?.logo?.url).toContain("/og/default.png");
      expect(article.headline.length).toBeLessThanOrEqual(110);
    }
  });

  it("no error page exceeds 50 KB (§6.2 page weight)", async () => {
    for (const [key, html] of await renderedErrorPages()) {
      expect(html.length, `${key} is ${html.length}B`).toBeLessThan(50_000);
    }
  });

  it("internal links resolve to a built HTML file", () => {
    const files = htmlFiles(dist);
    const broken: string[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!);
      for (const href of Array.from(new Set(hrefs))) {
        const key = `${f} → ${href}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const target = hrefToDistPath(href);
        if (target === null) continue;
        if (!existsSync(target)) broken.push(`${f} → ${href}`);
      }
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("every registered guide builds a page, plus the hub", () => {
    expect(existsSync(resolve(dist, "guides", "index.html"))).toBe(true);
    for (const g of GUIDES) {
      expect(existsSync(resolve(dist, "guides", g.slug, "index.html")), g.slug).toBe(true);
    }
    // guides are in the static-pages sitemap
    const xml = readFileSync(resolve(dist, "sitemaps", "pages.xml"), "utf8");
    for (const g of GUIDES) expect(xml).toContain(`/guides/${g.slug}/`);
  });

  it("error pages link the guides their code/message matches", async () => {
    const pages = await renderedErrorPages();
    for (const e of readErrorRecords()) {
      const html = pages.get(`${e.repo}/${e.slug}`)!;
      for (const g of guidesFor(e.errorCode, e.errorMessage)) {
        expect(html, `${e.slug} → ${g.slug}`).toContain(`/guides/${g.slug}/`);
      }
    }
    // the fixture dataset must exercise the matcher at least once
    const linked = readErrorRecords().some((e) => guidesFor(e.errorCode, e.errorMessage).length > 0);
    expect(linked).toBe(true);
  });

  it("robots.txt + sitemap-index + llms.txt are emitted", () => {
    expect(existsSync(resolve(dist, "robots.txt"))).toBe(true);
    expect(existsSync(resolve(dist, "sitemap-index.xml"))).toBe(true);
    expect(existsSync(resolve(dist, "llms.txt"))).toBe(true);
    expect(existsSync(resolve(dist, "_headers"))).toBe(true);
  });

  it("keeps the bare pages.dev mirror out of the index", () => {
    // Prerendered pages never pass through the middleware's canonical-host
    // redirect (the adapter serves them from ASSETS first), so every repo
    // page, the sitemap index and robots.txt answer 200 on errlookup.pages.dev.
    // _redirects cannot match a hostname; a host-matched _headers rule can.
    const headers = readFileSync(resolve(dist, "_headers"), "utf8");
    const rule = headers.match(/^https:\/\/errlookup\.pages\.dev\/\*\n((?:[ \t]+.*\n)+)/m);
    expect(rule, "no rule for https://errlookup.pages.dev/*").not.toBeNull();
    expect(rule![1]).toMatch(/X-Robots-Tag:\s*noindex/);
  });

  it("ships the dataset's JSON Schema at the URL its $id declares", () => {
    // /api-docs/ and llms.txt have linked /schema.json since launch; it 404ed
    // for as long as the link existed because nothing emitted it.
    const file = resolve(dist, "schema.json");
    expect(existsSync(file), "dist/schema.json missing").toBe(true);
    const schema = JSON.parse(readFileSync(file, "utf8"));
    expect(schema.$id).toBe("https://errors.standardbeagle.com/schema.json");
    expect(schema.definitions?.ErrorEntry).toBeDefined();
  });


  it("dates the articles and posts in the static-pages sitemap", () => {
    // Every article carries generatedAt and every post a date, but pages.xml
    // listed them undated, so a crawler had to fetch all ~190 to learn that
    // none had changed. Undated entries are honest only for pages with no
    // tracked change date (the hubs, about, the guides).
    const xml = readFileSync(resolve(dist, "sitemaps", "pages.xml"), "utf8");
    const dated = new Map(
      [...xml.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/url>/g)].map((m) => [m[1]!, m[2]!])
    );
    const infoIndex = resolve(publicData, "info", "index.json");
    const articles = existsSync(infoIndex)
      ? (JSON.parse(readFileSync(infoIndex, "utf8")) as { slug: string; generatedAt: string }[])
      : [];
    expect(articles.length).toBeGreaterThan(0);
    for (const a of articles) {
      expect(dated.get(`https://errors.standardbeagle.com/info/${a.slug}/`), a.slug).toBe(a.generatedAt.slice(0, 10));
    }
    for (const p of posts) {
      expect(dated.get(`https://errors.standardbeagle.com/blog/${p.slug}/`), p.slug).toBe(p.date);
    }
  });

  it("cuts article descriptions on a word boundary", () => {
    // Error pages already do; the article template used summary.slice(0, 155),
    // which ends mid-word whenever a summary runs long — machine-looking
    // output in the one line a searcher reads.
    const infoIndex = resolve(publicData, "info", "index.json");
    const articles = JSON.parse(readFileSync(infoIndex, "utf8")) as { slug: string; summary: string }[];
    for (const a of articles) {
      const html = readFileSync(resolve(dist, "info", a.slug, "index.html"), "utf8");
      const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
      expect(description, a.slug).toBe(truncateAtWord(a.summary, 160));
    }
  });

  it("serves the sitemap index at the conventional /sitemap.xml", () => {
    const canonical = resolve(dist, "sitemap.xml");
    expect(existsSync(canonical)).toBe(true);
    // Both paths must be the same document — a crawler that found one and a
    // console that submitted the other have to see the same child sitemaps.
    expect(readFileSync(canonical, "utf8")).toBe(readFileSync(resolve(dist, "sitemap-index.xml"), "utf8"));
  });

  it("packs the corpus into few sitemap shards, each one reachable", () => {
    // One file per repo produced 1,658 children with a median of 49 URLs
    // against a Googlebot budget of 35-94 requests a day — roughly a month
    // spent reading sitemaps before fetching a page. The protocol allows
    // 50,000 URLs per file and offers no other grouping, so pack them.
    const xml = readFileSync(resolve(dist, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs[0]).toBe("https://errors.standardbeagle.com/sitemaps/pages.xml");
    expect(locs.slice(1).every((l) => /\/sitemaps\/urls-\d+\.xml$/.test(l))).toBe(true);

    // A sitemap index pointing at a 404 is worse than no sitemap: the crawler
    // drops the whole submission.
    for (const loc of locs) {
      const rel = loc.replace("https://errors.standardbeagle.com/", "");
      expect(existsSync(resolve(dist, rel)), `missing ${rel}`).toBe(true);
    }
  });

  it("renders every repo into the shard sitemap-shards.json assigns it", () => {
    // Shard membership is permanent (pipeline exporter/sitemap-shards.ts); the
    // site must follow the dataset, never re-slice, or URLs move between files.
    const { repos } = JSON.parse(readFileSync(resolve(dist, "data", "sitemap-shards.json"), "utf8")) as {
      repos: Record<string, number>;
    };
    expect(new Set(Object.values(repos)).size, "fixture should span more than one shard").toBeGreaterThan(1);
    for (const [repo, shard] of Object.entries(repos)) {
      const body = readFileSync(resolve(dist, "sitemaps", `urls-${shard}.xml`), "utf8");
      expect(body, `${repo} not in urls-${shard}.xml`).toContain(`<loc>https://errors.standardbeagle.com/${repo}/</loc>`);
    }
  });

  it("loses no URL and repeats none when packing shards", () => {
    // The failure mode of packing is a slice boundary that drops or doubles a
    // URL, and it would be invisible — the index still looks right.
    const xml = readFileSync(resolve(dist, "sitemap.xml"), "utf8");
    const shardFiles = [...xml.matchAll(/<loc>([^<]+urls-\d+\.xml)<\/loc>/g)].map((m) =>
      m[1]!.replace("https://errors.standardbeagle.com/", "")
    );
    const seen: string[] = [];
    for (const f of shardFiles) {
      const body = readFileSync(resolve(dist, f), "utf8");
      seen.push(...[...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!));
    }
    expect(new Set(seen).size, "a URL appears in two shards").toBe(seen.length);

    // Every admitted repo's landing page must be in there somewhere.
    const repos = JSON.parse(readFileSync(resolve(dist, "data", "published.json"), "utf8")) as string[];
    for (const r of repos) {
      expect(seen, `${r} missing from every shard`).toContain(`https://errors.standardbeagle.com/${r}/`);
    }
  });

  it("every child sitemap entry carries the lastmod of the document it points at", () => {
    // Without lastmod the index is a flat list of ~1,400 files and a crawler
    // has to fetch all of them to find the one that moved. With a WRONG
    // lastmod it is worse than flat. So the index date must equal the newest
    // date inside the child it names.
    const xml = readFileSync(resolve(dist, "sitemap-index.xml"), "utf8");
    const entries = [...xml.matchAll(/<sitemap><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/sitemap>/g)];
    expect(entries.length).toBeGreaterThan(1);

    let dated = 0;
    for (const [, loc, lastmod] of entries) {
      const rel = loc!.replace("https://errors.standardbeagle.com/", "");
      // pages.xml holds static pages with no tracked change date; a missing
      // lastmod is honest there and legal in the schema.
      if (rel === "sitemaps/pages.xml") continue;
      expect(lastmod, `no lastmod for ${rel}`).toBeTruthy();
      expect(lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const child = readFileSync(resolve(dist, rel), "utf8");
      const dates = [...child.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]!);
      expect(dates.length, `child ${rel} has no dated URLs`).toBeGreaterThan(0);
      expect(lastmod, `index date disagrees with ${rel}`).toBe(dates.sort().at(-1));
      dated++;
    }
    expect(dated).toBeGreaterThan(0);
  });

  it("robots.txt points at the canonical sitemap", () => {
    const robots = readFileSync(resolve(dist, "robots.txt"), "utf8");
    expect(robots).toContain("Sitemap: https://errors.standardbeagle.com/sitemap-index.xml");
  });
});

describe("background article matching", () => {
  it("matches backgroundTag first, then the slugified error code, else null", async () => {
    const { findBackgroundArticle } = await import("../src/data/runtime.js");
    const index = [
      { slug: "connection-refused", title: "t1", summary: "s", errorCount: 6, repoCount: 2, generatedAt: "2026-08-12T00:00:00Z" },
      { slug: "err-bad-response", title: "t2", summary: "s", errorCount: 1, repoCount: 1, generatedAt: "2026-08-12T00:00:00Z" },
    ];
    expect(findBackgroundArticle(index, { backgroundTag: "connection-refused", errorCode: "ERR_BAD_RESPONSE" })?.slug).toBe("connection-refused");
    expect(findBackgroundArticle(index, { backgroundTag: null, errorCode: "ERR_BAD_RESPONSE" })?.slug).toBe("err-bad-response");
    expect(findBackgroundArticle(index, { backgroundTag: null, errorCode: "ENOENT" })).toBeNull();
    expect(findBackgroundArticle([], { backgroundTag: "connection-refused", errorCode: null })).toBeNull();
  });
});

describe("info pages", () => {
  // The dist mirrors whatever dataset was present at build time: the seeded
  // fixture always has one info page; a real exported dataset has them once
  // the collector has run. Either way the hub must prerender.
  it("prerenders the hub", () => {
    expect(existsSync(resolve(dist, "info", "index.html"))).toBe(true);
  });

  it("prerenders one page per dataset entry with its sections and links", () => {
    const idxPath = resolve(publicData, "info", "index.json");
    if (!existsSync(idxPath)) return; // pre-collector dataset: hub renders its empty state
    const entries = JSON.parse(readFileSync(idxPath, "utf8")) as { slug: string; title: string }[];
    const hub = readFileSync(resolve(dist, "info", "index.html"), "utf8");
    for (const e of entries) {
      expect(hub).toContain(`/info/${e.slug}/`);
      const html = readFileSync(resolve(dist, "info", e.slug, "index.html"), "utf8");
      const page = JSON.parse(readFileSync(resolve(publicData, `info/${e.slug}.json`), "utf8"));
      expect(html).toContain("Common causes");
      for (const c of page.commonCauses) expect(html).toContain(c.cause);
      for (const g of page.guideSlugs) expect(html).toContain(`/guides/${g}/`);
    }
  });
});

describe("404 page", () => {
  it("emits /404.html at the dist root, not a /404/ directory", () => {
    // Cloudflare Pages serves the not-found body from /404.html specifically.
    // Astro's build.format is "directory", so this is the one route where the
    // flat filename matters — /404/index.html would never be served.
    expect(existsSync(resolve(dist, "404.html"))).toBe(true);
    expect(existsSync(resolve(dist, "404"))).toBe(false);
  });

  it("is noindex and carries no canonical of its own", () => {
    const html = readFileSync(resolve(dist, "404.html"), "utf8");
    expect(html).toContain('name="robots" content="noindex, follow"');
    // The body answers every unmatched path, so a canonical derived from the
    // route would point crawlers at /404/, which 404s in turn.
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('property="og:url"');
  });

  it("offers working recovery links", () => {
    const html = readFileSync(resolve(dist, "404.html"), "utf8");
    const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs).toContain("/");
    expect(hrefs).toContain("/request-crawl/");
    for (const href of new Set(hrefs)) {
      const target = hrefToDistPath(href);
      if (target === null) continue;
      expect(existsSync(target), `dead 404-page link: ${href}`).toBe(true);
    }
  });

  it("is not advertised in the sitemap", () => {
    const xml = readFileSync(resolve(dist, "sitemaps", "pages.xml"), "utf8");
    expect(xml).not.toContain("404");
  });
});

describe("error search", () => {
  it("puts the search box in the header of every page", () => {
    // Pasting an error message is the site's primary action — it has to be
    // reachable from wherever a search engine dropped the visitor.
    for (const f of htmlFiles(dist)) {
      const html = readFileSync(f, "utf8");
      expect(html, `no header search on ${f}`).toContain('class="navsearch"');
      expect(html).toContain('action="/search/"');
      expect(html).toContain('name="q"');
    }
  });

  it("labels the search inputs for screen readers", () => {
    const html = readFileSync(resolve(dist, "index.html"), "utf8");
    expect(html).toContain('role="search"');
    // The visible control is placeholder-only, so the label must exist offscreen.
    expect(html).toMatch(/<label class="sr-only" for="nav-q">/);
  });

  it("builds a /search/ page that reads the q parameter", () => {
    const html = readFileSync(resolve(dist, "search", "index.html"), "utf8");
    expect(html).toContain('URLSearchParams(location.search).get("q")');
    expect(html).toContain("/api/search?limit=25&q=");
    // Degrades to something actionable rather than a blank page.
    expect(html).toContain("<noscript>");
  });

  it("keeps query-shaped result pages out of the index and the sitemap", () => {
    const html = readFileSync(resolve(dist, "search", "index.html"), "utf8");
    expect(html).toContain('name="robots" content="noindex, follow"');
    expect(html).not.toContain('rel="canonical"');
    const xml = readFileSync(resolve(dist, "sitemaps", "pages.xml"), "utf8");
    expect(xml).not.toContain("/search/");
  });
});

describe("page titles", () => {
  it("never repeats the error message inside a title", async () => {
    const pages = await renderedErrorPages();
    for (const e of readErrorRecords()) {
      const html = pages.get(`${e.repo}/${e.slug}`)!;
      const title = html.match(/<title>([^<]*)<\/title>/)![1]!;
      // A codeless error used to render "<msg truncated>: <msg>".
      const head = title.split(" — ")[0]!;
      const halves = head.split(": ");
      if (halves.length > 1) {
        expect(halves[0], `title stutters: ${title}`).not.toBe(halves.slice(1).join(": "));
        expect(halves.slice(1).join(": ").startsWith(halves[0]!)).toBe(false);
      }
    }
  });

  it("gives every page a unique, non-empty title", () => {
    const seen = new Map<string, string>();
    for (const f of htmlFiles(dist)) {
      const title = readFileSync(f, "utf8").match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
      expect(title.length, `empty title in ${f}`).toBeGreaterThan(0);
      // Duplicate titles across URLs are how a site gets pages collapsed as
      // near-duplicates in search results.
      expect(seen.has(title), `duplicate title "${title}" in ${f} and ${seen.get(title)}`).toBe(false);
      seen.set(title, f);
    }
  });
});

describe("social cards", () => {
  it("gives every page an absolute og:image that exists in dist", () => {
    for (const f of htmlFiles(dist)) {
      const html = readFileSync(f, "utf8");
      const src = html.match(/property="og:image" content="([^"]+)"/)?.[1];
      expect(src, `no og:image on ${f}`).toBeTruthy();
      // Scrapers fetch the card out of page context; a relative path yields no
      // preview at all, which is indistinguishable from having no card.
      expect(src!.startsWith("https://errors.standardbeagle.com/")).toBe(true);
      const rel = src!.replace("https://errors.standardbeagle.com/", "");
      expect(existsSync(resolve(dist, rel)), `missing card ${rel} for ${f}`).toBe(true);
    }
  });

  it("uses the repo's card on its error pages and a per-post card on the blog", async () => {
    const pages = await renderedErrorPages();
    for (const e of readErrorRecords()) {
      const html = pages.get(`${e.repo}/${e.slug}`)!;
      const [owner, name] = e.repo.split("/");
      expect(html).toContain(`/og/repo-${owner}-${name}.png`);
    }
    const post = readFileSync(resolve(dist, "blog", "how-the-scanner-works", "index.html"), "utf8");
    expect(post).toContain("/og/blog-how-the-scanner-works.png");
  });

  it("declares the large-image card type so the PNG is actually shown", () => {
    const html = readFileSync(resolve(dist, "index.html"), "utf8");
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:image:width" content="1200"');
  });
});

describe("RSS feed", () => {
  it("emits a feed listing every blog post, newest first", () => {
    const xml = readFileSync(resolve(dist, "rss.xml"), "utf8");
    const links = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]!);
    const items = [...xml.matchAll(/<item>/g)].length;
    // Every post the blog index shows must appear in the feed.
    const listed = [...readFileSync(resolve(dist, "blog", "index.html"), "utf8")
      .matchAll(/href="\/blog\/([a-z0-9-]+)\/"/g)].map((m) => m[1]!);
    expect(items).toBe(new Set(listed).size);
    for (const slug of new Set(listed)) {
      expect(links.some((l) => l.endsWith(`/blog/${slug}/`)), `feed missing ${slug}`).toBe(true);
    }
  });

  it("uses RFC-822 dates and a self link, as validators require", () => {
    const xml = readFileSync(resolve(dist, "rss.xml"), "utf8");
    expect(xml).toContain('rel="self"');
    for (const d of [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => m[1]!)) {
      expect(Number.isNaN(Date.parse(d)), `unparseable pubDate: ${d}`).toBe(false);
      expect(d).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
    }
  });

  it("is discoverable from every page", () => {
    for (const f of htmlFiles(dist)) {
      expect(readFileSync(f, "utf8"), `no feed link on ${f}`).toContain(
        '<link rel="alternate" type="application/rss+xml"'
      );
    }
  });
});

describe("breadcrumbs", () => {
  it("puts a BreadcrumbList on repo and error pages", async () => {
    const pages = await renderedErrorPages();
    for (const e of readErrorRecords()) {
      const html = pages.get(`${e.repo}/${e.slug}`)!;
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      const graph = blocks.flatMap((m) => {
        const ld = JSON.parse(m[1]!);
        return ld["@graph"] ?? [ld];
      });
      const crumb = graph.find((g: { "@type": string }) => g["@type"] === "BreadcrumbList");
      expect(crumb, `no breadcrumb on ${e.slug}`).toBeTruthy();
      const positions = crumb.itemListElement.map((i: { position: number }) => i.position);
      expect(positions).toEqual([1, 2, 3]); // site > repo > error
      expect(crumb.itemListElement[2].item).toContain(`/${e.repo}/${e.slug}/`);
    }
  });
});

/** The global stylesheet Astro emits for the layout (minified, hashed name). */
function siteCss(): string {
  const dir = resolve(dist, "_astro");
  const file = readdirSync(dir).find((f) => f.endsWith(".css"));
  return readFileSync(resolve(dir, file!), "utf8");
}

describe("header and layout contract", () => {
  it("keeps the header to four destinations plus search", () => {
    const html = readFileSync(resolve(dist, "index.html"), "utf8");
    const nav = html.match(/<nav class="top">[\s\S]*?<\/nav>/)![0];
    const links = [...nav.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]!);
    // brand + Troubleshooting + About + API + GitHub. The bar also carries a
    // search field, and every extra link steals width from it — the
    // pre-redesign nav wrapped to two rows and stranded items on the second.
    // Blog moved to the footer when Troubleshooting took its header slot.
    expect(links).toEqual(["/", "/troubleshooting/", "/about/", "/api-docs/", "https://github.com/standardbeagle/err-lookup"]);
    expect(nav).toContain('class="navsearch"');
  });

  it("keeps the links removed from the header reachable in the footer", () => {
    const footer = readFileSync(resolve(dist, "index.html"), "utf8").match(/<footer[\s\S]*?<\/footer>/)![0];
    expect(footer).toContain('href="/request-crawl/"');
    expect(footer).toContain('href="/blog/"');
    expect(footer).toContain("errlookup-mcp");
  });

  it("offers a skip link ahead of the nav on every page", () => {
    for (const f of htmlFiles(dist)) {
      const html = readFileSync(f, "utf8");
      expect(html, `no skip link in ${f}`).toContain('class="skip btn" href="#main"');
      // It must precede the nav, or it skips nothing.
      expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf('<nav class="top">'));
      expect(html).toContain('id="main"');
    }
  });

  it("constrains prose to a readable measure inside the wider shell", () => {
    // Astro extracts the global stylesheet, so these live in the CSS bundle
    // rather than the document, and ship minified.
    const css = siteCss();
    // Minifiers preserve custom-property values verbatim, spaces included.
    expect(css).toMatch(/--maxw:\s*1120px/);
    expect(css).toMatch(/--measure:\s*\d+ch/);
    // Without this, a 1120px shell runs body text past 150 characters a line.
    expect(css).toMatch(/main>:is\(p,ul,ol,h1,h2,h3,blockquote\)[^}]*max-width:var\(--measure\)/);
  });

  it("lets wide tables scroll inside themselves on small screens", () => {
    // A four-column table cannot fit 320px; unconstrained it drags the whole
    // page sideways and breaks every other element's layout.
    const css = siteCss();
    expect(css).toMatch(/max-width:\s*600px\)\{[^@]*?main table\{display:block;overflow-x:auto\}/);
  });
});

describe("an error URL with no record", () => {
  const origin = "https://errors.standardbeagle.com";

  it("redirects to the repo index, naming why, when the repo is still published", () => {
    // These are pages we published and search engines indexed; a later
    // re-analysis stopped rediscovering them. 404ing them is what taught
    // crawlers to stop coming back — and a bare redirect reads as a broken
    // link, so the query string carries the reason for the repo page to show.
    expect(missingErrorPage(true, "axios", "axios", origin, "err-gone")).toEqual({
      kind: "redirect",
      location: "https://errors.standardbeagle.com/axios/axios/?reason=removed&from=err-gone",
    });
    expect(missingErrorPage(true, "axios", "axios", origin)).toEqual({
      kind: "redirect",
      location: "https://errors.standardbeagle.com/axios/axios/?reason=removed",
    });
  });

  it("404s when the repo itself is not in the dataset", () => {
    // Nowhere honest to send it — a redirect here would be a soft 404.
    expect(missingErrorPage(false, "nobody", "nothing", origin)).toEqual({ kind: "not-found" });
  });
});
