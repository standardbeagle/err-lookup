import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractCandidatesLci } from "../src/phase/candidates.js";
import { stopLciServer } from "../src/util/lci-server.js";
import { tmpRepo, disposeRepo } from "./tmp-repo.js";

/** lci servers currently running, whichever root they hold. */
function runningLciRoots(): string[] {
  const listing = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  const roots: string[] = [];
  for (const line of listing.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const bin = tokens[1] ?? "";
    if (!(bin === "lci" || bin.endsWith("/lci"))) continue;
    const i = tokens.findIndex((t) => t === "--root" || t === "-r");
    if (i >= 0 && tokens[i + 1]) roots.push(tokens[i + 1]!);
  }
  return roots;
}

describe("lci server teardown", () => {
  it("leaves no server behind after a repo that was indexed is disposed", () => {
    const dir = tmpRepo("lci-teardown-");
    writeFileSync(join(dir, "a.js"), "function f(x) {\n  if (!x) throw new TypeError('nope');\n}\n");

    let indexed = false;
    try {
      extractCandidatesLci(dir);
      indexed = true;
    } catch (e) {
      // Only an absent binary is acceptable; anything else is a real failure.
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }

    if (!indexed) {
      disposeRepo(dir);
      return; // no lci on this host, nothing to tear down
    }

    // Indexing starts a persistent server for this root.
    expect(runningLciRoots()).toContain(dir);

    disposeRepo(dir);

    // The regression this guards: for a long time nothing stopped the server, so
    // each run stranded one rooted at a directory that no longer existed.
    expect(runningLciRoots()).not.toContain(dir);
  });

  it("reports success for a root that never had a server", () => {
    const dir = tmpRepo("lci-noserver-");
    expect(stopLciServer(dir)).toEqual([]);
    disposeRepo(dir);
  });

  it("matches the root exactly, so it cannot kill a sibling's server", () => {
    // A substring match on a mkdtemp prefix would hit every sibling fixture's
    // server and take out a concurrently running job. Assert the narrow case:
    // asking about a prefix of a real root must find nothing to stop.
    const dir = tmpRepo("lci-sibling-");
    writeFileSync(join(dir, "a.js"), "throw new Error('x');\n");
    let indexed = false;
    try {
      extractCandidatesLci(dir);
      indexed = true;
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    if (indexed) {
      const prefix = dir.slice(0, -3); // a strict prefix of the real root
      expect(stopLciServer(prefix)).toEqual([]);
      expect(runningLciRoots()).toContain(dir); // untouched
    }
    disposeRepo(dir);
  });
});
