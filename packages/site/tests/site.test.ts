import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, "..");
const dist = resolve(siteRoot, "dist");
const publicData = resolve(siteRoot, "public", "data");

function readErrorRecords(): { repo: string; slug: string; errorMessage: string; id: string }[] {
  const repos = JSON.parse(readFileSync(resolve(publicData, "repos.json"), "utf8")) as { repo: string }[];
  const out: { repo: string; slug: string; errorMessage: string; id: string }[] = [];
  for (const r of repos) {
    const [owner, name] = r.repo.split("/");
    const errors = JSON.parse(readFileSync(resolve(publicData, `repos/${owner}/${name}.json`), "utf8"));
    for (const e of errors) out.push({ repo: r.repo, slug: e.slug, errorMessage: e.errorMessage, id: e.id });
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
      expect(html).toContain(`/data/errors/${e.id}.json`);
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

  it("robots.txt + sitemap-index + llms.txt are emitted", () => {
    expect(existsSync(resolve(dist, "robots.txt"))).toBe(true);
    expect(existsSync(resolve(dist, "sitemap-index.xml"))).toBe(true);
    expect(existsSync(resolve(dist, "llms.txt"))).toBe(true);
    expect(existsSync(resolve(dist, "_headers"))).toBe(true);
  });
});
