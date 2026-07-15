import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the drizzle migrations folder robustly across invocation modes
 * (tsx-from-source, compiled dist, vitest transform). Returns the first
 * candidate that contains `meta/_journal.json`.
 */
function resolveMigrationsFolder(): string {
  const candidates = [
    join(process.cwd(), "drizzle"),
    join(process.cwd(), "packages", "pipeline", "drizzle"),
    resolve(__dirname, "..", "drizzle"), // src/db → packages/pipeline/drizzle
    resolve(__dirname, "..", "..", "drizzle"), // dist/db → packages/pipeline/drizzle
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "meta", "_journal.json"))) return c;
  }
  return candidates[0]!;
}

/**
 * Open the pipeline SQLite working DB. Enables WAL + busy_timeout + foreign_keys
 * (spec §3.2). Runs drizzle migrations so the file is always at head schema.
 */
export function openDb(dbPath: string): { db: Db; raw: Database.Database } {
  if (!dbPath.endsWith(":memory:")) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  raw.pragma("synchronous = NORMAL");

  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  return { db, raw };
}

/** Run `fn` inside a transaction. All multi-row writes must go through this (§3.2). */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn);
}
