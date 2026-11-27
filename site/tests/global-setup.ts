import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One site build for the whole suite.
 *
 * Every suite that asserts on emitted HTML used to build the site itself:
 * site.test.ts once, paging.test.ts twice — the second only to restore the
 * shared dist/ the first had overwritten. Three builds of the same fixture,
 * serialized by fileParallelism:false, for one artifact they all read.
 *
 * The page sizes are forced small because the fixture is deliberately tiny (a
 * couple of repos and a handful of errors). At production page sizes it would
 * render one page per list and exercise no paging at all; the alternative —
 * growing the fixture past 25 repos, 100 errors and 50 articles — would make
 * every build slower to prove the same thing.
 */
export default async function setup(): Promise<void> {
  const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!existsSync(resolve(siteRoot, "public", "data", "manifest.json"))) {
    execFileSync("pnpm", ["exec", "tsx", "scripts/seed-dataset.ts"], { cwd: siteRoot });
  }
  execFileSync("pnpm", ["exec", "astro", "build"], {
    cwd: siteRoot,
    stdio: "pipe",
    env: {
      ...process.env,
      ERRLOOKUP_REPOS_PER_PAGE: "1",
      ERRLOOKUP_ERRORS_PER_PAGE: "1",
      ERRLOOKUP_ARTICLES_PER_PAGE: "1",
    },
  });
}
