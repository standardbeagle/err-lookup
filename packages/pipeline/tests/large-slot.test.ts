import { describe, it, expect, afterEach } from "vitest";
import { needsLargeSlot } from "../src/pipeline.js";

afterEach(() => {
  delete process.env.ERRLOOKUP_LARGE_CLONE_MB;
  delete process.env.ERRLOOKUP_LARGE_SOURCE_FILES;
});

describe("large-repo slot gate", () => {
  it("trips on source-file count even when the shallow clone is small", () => {
    // golang/go: 361MB / 3,996 files; elasticsearch: 723MB / 20,132 files.
    // Both ran concurrently under the old 2GB byte-only threshold.
    expect(needsLargeSlot(361, 3996)).toBe(true);
    expect(needsLargeSlot(723, 20132)).toBe(true);
  });

  it("leaves ordinary repos unserialized", () => {
    expect(needsLargeSlot(48, 726)).toBe(false); // node-redis-sized
    expect(needsLargeSlot(120, 1538)).toBe(false); // prisma-sized
  });

  it("trips on clone bytes alone for source-light giants", () => {
    expect(needsLargeSlot(900, 400)).toBe(true);
  });

  it("honors the env overrides", () => {
    process.env.ERRLOOKUP_LARGE_CLONE_MB = "10000";
    process.env.ERRLOOKUP_LARGE_SOURCE_FILES = "100000";
    expect(needsLargeSlot(723, 20132)).toBe(false);
  });
});
