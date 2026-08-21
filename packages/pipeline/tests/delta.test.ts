import { describe, it, expect } from "vitest";
import {
  parseUnifiedDiff,
  oldLineTouched,
  newLineTouched,
  remapOldLine,
  planRescan,
  candidateInReview,
  deltaTooLarge,
} from "../src/phase/delta.js";
import type { ErrorRow } from "../src/db/schema.js";

const DIFF = `diff --git a/src/a.js b/src/a.js
index 1111111..2222222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,0 +2,3 @@ header
+// one
+// two
+// three
@@ -40,2 +43,1 @@ function f() {
-  throw new Error("old message");
-  // trailing
+  throw new Error("new message");
diff --git a/src/new.js b/src/new.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,2 @@
+export function g() {
+  throw new Error("fresh");
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.js
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-x
+y
`;

function row(filePath: string, lineNumber: number | null, id = `${filePath}:${lineNumber}`): ErrorRow {
  return { id, repo: "o/r", slug: id, filePath, lineNumber } as unknown as ErrorRow;
}

describe("unified diff → plan", () => {
  it("parses A/M/D files with their hunks (renames disabled → D + A)", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.hunks.length])).toEqual([
      ["src/a.js", "M", 2],
      ["src/new.js", "A", 1],
      ["src/gone.js", "D", 1],
      ["README.md", "M", 1],
    ]);
    expect(files[0]!.hunks[0]).toEqual({ oldStart: 1, oldLen: 0, newStart: 2, newLen: 3 });
    expect(files[0]!.hunks[1]).toEqual({ oldStart: 40, oldLen: 2, newStart: 43, newLen: 1 });
  });

  it("touched = inside a hunk or within the pad of one, on either side", () => {
    const hunks = parseUnifiedDiff(DIFF)[0]!.hunks;
    expect(oldLineTouched(hunks, 40)).toBe(true);
    expect(oldLineTouched(hunks, 44)).toBe(true); // last line of the pad below the edit
    expect(oldLineTouched(hunks, 45)).toBe(false);
    expect(oldLineTouched(hunks, 20)).toBe(false);
    expect(oldLineTouched(hunks, 2)).toBe(true); // insertion seam at 1|2
    expect(newLineTouched(hunks, 43)).toBe(true);
    expect(newLineTouched(hunks, 47)).toBe(false);
    expect(newLineTouched(hunks, 3)).toBe(true); // inside the inserted block
  });

  it("re-anchors an untouched old line past the net size of the hunks above it", () => {
    const hunks = parseUnifiedDiff(DIFF)[0]!.hunks;
    expect(remapOldLine(hunks, 20)).toBe(23); // +3 inserted at top
    expect(remapOldLine(hunks, 60)).toBe(62); // +3 −1
  });

  it("splits published records into carry-over / remapped / dropped and names the review files", () => {
    const published = [
      row("src/a.js", 20), // untouched line in a modified file → remapped
      row("src/a.js", 40), // edited site → dropped (may be reused by identity)
      row("src/a.js", null), // no line → cannot be placed → dropped
      row("src/gone.js", 2), // deleted file → dropped
      row("src/keep.js", 7), // file not in diff → carry over verbatim
      row("README.md", 1), // irrelevant file: treated as untouched → carry over
    ];
    const plan = planRescan(published, parseUnifiedDiff(DIFF), (p) => p.endsWith(".js"));
    expect(plan.carryOver.map((r) => r.id)).toEqual(["src/keep.js:7", "README.md:1"]);
    expect(plan.remapped.map((m) => [m.row.id, m.newLine])).toEqual([["src/a.js:20", 23]]);
    expect(plan.dropped.map((r) => r.id)).toEqual(["src/a.js:40", "src/a.js:null", "src/gone.js:2"]);
    expect([...plan.reviewFiles.keys()]).toEqual(["src/a.js", "src/new.js"]);

    const only = candidateInReview(plan.reviewFiles);
    expect(only.files).toEqual(new Set(["src/a.js", "src/new.js"]));
    expect(only.line("src/new.js", 99)).toBe(true); // whole added file
    expect(only.line("src/a.js", 43)).toBe(true);
    expect(only.line("src/a.js", 20)).toBe(false);
    expect(only.line("src/keep.js", 1)).toBe(false);
  });

  it("a delta above the share threshold is not worth reviewing incrementally", () => {
    expect(deltaTooLarge(10, 100)).toBe(false);
    expect(deltaTooLarge(26, 100)).toBe(true);
    expect(deltaTooLarge(15, 40)).toBe(false); // under the absolute floor even though > 25%
    expect(deltaTooLarge(21, 40)).toBe(true);
    expect(deltaTooLarge(5, 0)).toBe(false); // unknown size never forces full
  });
});
