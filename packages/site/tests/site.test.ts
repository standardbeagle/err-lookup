import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GUIDES, guidesFor } from "../src/data/guides.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const dist = resolve(siteRoot, "dist");
const publicData = resolve(siteRoot, "public", "data");

function readErrorRecords(): {
  repo: string;
  slug: string;
  errorMessage: string;
  errorCode: string | null;
  id: string;
}[] {
  const repos = JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as { repo: string }[];
  const out: ReturnType<typeof readErrorRecords> = [];
  for (const r of repos) {
    const [owner, name] = r.repo.split("/");
    const errors = JSON.parse(readFileSync(resolve(publicData, `repos/${owner}/${name}.json`), "utf8"));
    for (const e of errors)
      out.push({ repo: r.repo, slug: e.slug, errorMessage: e.errorMessage, errorCode: e.errorCode ?? null, id: e.id });
  }
  return out;
}

beforeAll(() => {
  // Ensure a seeded dataset exists, then (re)build the site for assertions.
  if (!existsSync(resolve(publicData, "manifest.json"))) {
    execFileSync("node", ["scripts/seed-dataset.mjs"], { cwd: siteRoot });
  }
  execFileSync("pnpm", ["exec", "astro", "build"], { cwd: siteRoot, stdio: "pipe" });
}, 60_000);

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
  if (href.startsWith("/api/")) return null; // served by the Pages Function, no dist file
  const clean = href.split("#")[0]!.split("?")[0]!;
  const rel = clean.replace(/^\//, "");
  // Static assets (favicon, media, etc.) must exist in dist as plain files.
  if (/\.(svg|ico|png|jpe?g|gif|webp|json|xml|txt|css|js|map|mp4|webm|pdf)$/.test(clean)) {
    return resolve(dist, rel);
  }
  if (rel === "") return resolve(dist, "index.html");
  return resolve(dist, rel, "index.html");
}

describe("site build (§8.3)", () => {
  it("produces every error page", () => {
    for (const e of readErrorRecords()) {
      const p = resolve(dist, e.repo, e.slug, "index.html");
      expect(existsSync(p), `missing ${p}`).toBe(true);
    }
  });

  it("each error page contains the exact error message + JSON twin link", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
      expect(html).toContain(e.errorMessage);
      expect(html).toContain(`/api/errors/${e.id}`);
    }
  });

  it("JSON-LD on error pages parses and carries TechArticle + FAQPage", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(m, `no JSON-LD on ${e.slug}`).not.toBeNull();
      const ld = JSON.parse(m![1]);
      const types = ld["@graph"].map((g: { "@type": string }) => g["@type"]);
      expect(types).toContain("TechArticle");
      expect(types).toContain("FAQPage");
    }
  });

  it("no error page exceeds 50 KB (§6.2 page weight)", () => {
    for (const e of readErrorRecords()) {
      const stat = statSync(resolve(dist, e.repo, e.slug, "index.html"));
      expect(stat.size, `${e.slug} is ${stat.size}B`).toBeLessThan(50_000);
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

  it("error pages link the guides their code/message matches", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
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

  it("serves the sitemap index at the conventional /sitemap.xml", () => {
    const canonical = resolve(dist, "sitemap.xml");
    expect(existsSync(canonical)).toBe(true);
    // Both paths must be the same document — a crawler that found one and a
    // console that submitted the other have to see the same child sitemaps.
    expect(readFileSync(canonical, "utf8")).toBe(readFileSync(resolve(dist, "sitemap-index.xml"), "utf8"));
  });

  it("sitemap.xml lists every repo's child sitemap, and each one exists", () => {
    const xml = readFileSync(resolve(dist, "sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.length).toBeGreaterThan(1); // pages.xml + at least one repo

    const repos = JSON.parse(readFileSync(resolve(dist, "data", "repos.json"), "utf8")) as { repo: string }[];
    expect(locs).toHaveLength(repos.length + 1);
    for (const r of repos) {
      expect(locs).toContain(`https://errors.standardbeagle.com/sitemaps/${r.repo}.xml`);
    }
    // A sitemap index pointing at a 404 is worse than no sitemap: the crawler
    // drops the whole submission.
    for (const loc of locs) {
      const rel = loc.replace("https://errors.standardbeagle.com/", "");
      expect(existsSync(resolve(dist, rel)), `missing ${rel}`).toBe(true);
    }
  });

  it("robots.txt points at the canonical sitemap", () => {
    const robots = readFileSync(resolve(dist, "robots.txt"), "utf8");
    expect(robots).toContain("Sitemap: https://errors.standardbeagle.com/sitemap.xml");
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
  it("never repeats the error message inside a title", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
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

  it("uses the repo's card on its error pages and a per-post card on the blog", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
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
  it("puts a BreadcrumbList on repo and error pages", () => {
    for (const e of readErrorRecords()) {
      const html = readFileSync(resolve(dist, e.repo, e.slug, "index.html"), "utf8");
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
    // brand + About + Blog + API + GitHub. The bar also carries a search field,
    // and every extra link steals width from it — the pre-redesign nav wrapped
    // to two rows and stranded items on the second.
    expect(links).toEqual(["/", "/about/", "/blog/", "/api-docs/", "https://github.com/standardbeagle/err-lookup"]);
    expect(nav).toContain('class="navsearch"');
  });

  it("keeps the links removed from the header reachable in the footer", () => {
    const footer = readFileSync(resolve(dist, "index.html"), "utf8").match(/<footer[\s\S]*?<\/footer>/)![0];
    expect(footer).toContain('href="/request-crawl/"');
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
