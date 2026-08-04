/**
 * One-off: count analyzable source files for repos analyzed before the
 * pipeline recorded source_files. Shallow-clones each repo missing a count.
 * usage: ERRLOOKUP_DB=... tsx scripts/backfill-source-files.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import { openDb } from "../src/db/client.js";
import { repositories } from "../src/db/schema.js";
import { upsertRepo } from "../src/db/store.js";
import { cloneShallow, tempWorkDir } from "../src/vcs/git.js";
import { countSourceFiles } from "../src/phase/candidates.js";
import { resolve } from "node:path";

const dbPath = process.env.ERRLOOKUP_DB ?? resolve(process.cwd(), "data", "errlookup.db");
const { db, raw } = openDb(dbPath);

// Only published repos: pending/failed rows get counted when their scan runs.
const rows = db
  .select()
  .from(repositories)
  .where(and(eq(repositories.status, "analyzed"), isNull(repositories.sourceFiles)))
  .all();
let updated = 0;
for (const r of rows) {
  const work = await tempWorkDir();
  try {
    await cloneShallow(r.repo, work.path);
    const sourceFiles = countSourceFiles(work.path);
    upsertRepo(db, { repo: r.repo, sourceFiles });
    console.log(`${r.repo}: ${sourceFiles} source files`);
    updated++;
  } catch (err) {
    console.error(`SKIP ${r.repo}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await work.cleanup();
  }
}
console.log(`backfilled ${updated}/${rows.length}`);
raw.close();
