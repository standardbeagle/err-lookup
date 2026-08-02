/**
 * Generate Open Graph social cards as PNGs into public/og/.
 *
 * Social platforms will not render SVG for og:image, so the cards are
 * rasterised here and committed as static assets rather than built on deploy —
 * they change only when a post or repo is added.
 *
 * Card inventory:
 *   default.png            every page without a more specific card
 *   blog-<slug>.png        one per post (distinct titles, most-shared pages)
 *   repo-<owner>-<name>.png  one per repo, reused by that repo's error pages
 *
 * Deliberately NOT one per error record: the dataset is heading for tens of
 * thousands of errors, and a per-record card would add hundreds of megabytes to
 * every deploy for pages that are individually rarely shared.
 */
import sharp from "sharp";
import { posts } from "../src/data/blog.js";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public", "og");

// Dark palette from Base.astro — cards read against both light and dark
// platform chrome, and dark matches how the brand mark is drawn.
const BG = "#191410";
const INK = "#ece4dc";
const MUTE = "#b3a396";
const ACCENT = "#fb923c";
const LINE = "#3d332b";

const W = 1200;
const H = 630;

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Greedy wrap by estimated advance width. SVG has no auto-wrapping, and pulling
 * in a font-metrics library to lay out six words is not worth the dependency —
 * the 0.54em average for bold Helvetica is close enough that lines land inside
 * the safe area.
 */
function wrap(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const perChar = fontSize * 0.54;
  const limit = Math.floor(maxWidth / perChar);
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= limit) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = last.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
  }
  return lines;
}

function card({ kicker, title, subtitle }: { kicker: string | null; title: string; subtitle: string }): string {
  const titleSize = title.length > 48 ? 62 : 76;
  const lines = wrap(title, titleSize, W - 130, 3);
  const startY = 300 - (lines.length - 1) * (titleSize * 0.6);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="0" width="${W}" height="8" fill="${ACCENT}"/>
  <g transform="translate(65,60)">
    <rect x="0" y="0" width="46" height="46" rx="11" fill="${ACCENT}"/>
    <path d="M13 17.6 20 23l-7 5.4M24 30h9.5" stroke="${BG}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="62" y="34" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="800" fill="${INK}">ErrLookup</text>
  </g>
  ${kicker ? `<text x="65" y="185" font-family="Helvetica,Arial,sans-serif" font-size="24" font-weight="700" fill="${ACCENT}" letter-spacing="2">${escapeXml(kicker.toUpperCase())}</text>` : ""}
  ${lines
    .map(
      (l, i) =>
        `<text x="65" y="${startY + i * (titleSize * 1.18)}" font-family="Helvetica,Arial,sans-serif" font-size="${titleSize}" font-weight="800" fill="${INK}">${escapeXml(l)}</text>`
    )
    .join("\n  ")}
  <line x1="65" y1="${H - 118}" x2="${W - 65}" y2="${H - 118}" stroke="${LINE}" stroke-width="2"/>
  <text x="65" y="${H - 66}" font-family="Helvetica,Arial,sans-serif" font-size="26" fill="${MUTE}">${escapeXml(subtitle)}</text>
</svg>`;
}

async function write(name: string, svg: string): Promise<number> {
  const buf = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(resolve(outDir, name), buf);
  return buf.length;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  let count = 0;
  let bytes = 0;

  bytes += await write(
    "default.png",
    card({
      kicker: null,
      title: "Know what every error means, and how to fix it.",
      subtitle: "errors.standardbeagle.com · MCP server + static JSON dataset",
    })
  );
  count++;

  for (const p of posts) {
    bytes += await write(
      `blog-${p.slug}.png`,
      card({ kicker: "Blog", title: p.title, subtitle: "errors.standardbeagle.com/blog" })
    );
    count++;
  }

  const reposFile = resolve(root, "public", "data", "repos.json");
  if (existsSync(reposFile)) {
    for (const r of JSON.parse(readFileSync(reposFile, "utf8"))) {
      const [owner, name] = r.repo.split("/");
      bytes += await write(
        `repo-${owner}-${name}.png`,
        card({
          kicker: r.language ?? "Repository",
          title: r.repo,
          subtitle: `${r.errorCount} documented ${r.errorCount === 1 ? "error" : "errors"} · errors.standardbeagle.com`,
        })
      );
      count++;
    }
  }

  console.log(`og: wrote ${count} cards, ${(bytes / 1024).toFixed(0)} KB total → public/og/`);
}

await main();
