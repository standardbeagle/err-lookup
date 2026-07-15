import type { Db } from "../db/client.js";
import { repositories, jobHistory } from "../db/schema.js";
import { desc, inArray } from "drizzle-orm";

/** `errlookup status` — table of repos, phases done, error counts (§4). */
export function printStatus(db: Db): void {
  const repos = db.select().from(repositories).orderBy(repositories.repo).all();

  if (repos.length === 0) {
    console.log("no repositories tracked yet. run: errlookup analyze <owner/repo>");
    return;
  }

  const repoNames = repos.map((r) => r.repo);
  const recentJobs = db
    .select()
    .from(jobHistory)
    .where(inArray(jobHistory.repo, repoNames))
    .orderBy(desc(jobHistory.startedAt))
    .all();

  const rows = repos.map((r) => {
    const phases = recentJobs
      .filter((j) => j.repo === r.repo)
      .slice(0, 5)
      .map((j) => `${j.phase}:${j.status[0]}`)
      .join(" ");
    return {
      repo: r.repo,
      status: r.status,
      errors: r.errorCount,
      sha: (r.analyzedSha ?? "").slice(0, 8),
      phases,
    };
  });

  const repoW = Math.max(8, ...rows.map((r) => r.repo.length));
  const phW = Math.max(6, ...rows.map((r) => r.phases.length));
  console.log(
    `${"repo".padEnd(repoW)}  ${"status".padEnd(10)}  ${"errs".padStart(4)}  ${"sha".padEnd(8)}  phases`
  );
  console.log(`${"-".repeat(repoW)}  ${"-".repeat(10)}  ${"-".repeat(4)}  ${"-".repeat(8)}  ${"-".repeat(phW)}`);
  for (const r of rows) {
    console.log(
      `${r.repo.padEnd(repoW)}  ${r.status.padEnd(10)}  ${String(r.errors).padStart(4)}  ${r.sha.padEnd(8)}  ${r.phases}`
    );
  }
}
