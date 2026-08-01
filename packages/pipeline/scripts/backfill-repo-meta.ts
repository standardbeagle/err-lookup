/**
 * One-off: fetch GitHub metadata (description/language/stars/defaultBranch)
 * for repos already analyzed before the pipeline recorded it.
 * usage: ERRLOOKUP_DB=... tsx scripts/backfill-repo-meta.ts
 */
import { openDb } from "../src/db/client.js";
import { repositories } from "../src/db/schema.js";
import { upsertRepo } from "../src/db/store.js";
import { fetchRepoMeta } from "../src/vcs/github-meta.js";
import { resolve } from "node:path";

const dbPath = process.env.ERRLOOKUP_DB ?? resolve(process.cwd(), "data", "errlookup.db");
const { db, raw } = openDb(dbPath);

const rows = db.select().from(repositories).all();
let updated = 0;
for (const r of rows) {
  const meta = await fetchRepoMeta(r.repo);
  if (!meta) {
    console.error(`SKIP ${r.repo}: GitHub API unavailable`);
    continue;
  }
  upsertRepo(db, { repo: r.repo, ...meta });
  console.log(`${r.repo}: ${meta.language ?? "?"} · ${meta.stars} stars`);
  updated++;
}
console.log(`backfilled ${updated}/${rows.length}`);
raw.close();
