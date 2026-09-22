import { describe, it, expect } from "vitest";
import { CANONICAL_TAGS } from "@errlookup/schema";
import {
  nameShape,
  messageMode,
  contentFamily,
  CONTENT_RULE_FAMILIES,
} from "../src/phase/tag-shape.js";

const page = (over: Partial<Parameters<typeof contentFamily>[0]> = {}) => ({
  errorClass: null,
  errorCode: null,
  httpStatus: null,
  errorMessage: "boom",
  ...over,
});

describe("nameShape", () => {
  it("reads the mode from either end and the object from what is left", () => {
    expect(nameShape("missing-env-var")).toEqual({ mode: "absent", object: "config", subject: "env" });
    expect(nameShape("config-file-not-found")).toEqual({ mode: "absent", object: "config", subject: "config" });
    expect(nameShape("invalid-url-format")).toMatchObject({ mode: "invalid", object: "format", subject: "url" });
    expect(nameShape("tensor-shape-mismatch")).toMatchObject({ mode: "mismatch", object: "array" });
  });

  it("lets a specific prefix outrank a generic failure suffix", () => {
    // "invalid JSON" is the fault; "-error" only says there was one.
    expect(nameShape("invalid-json-error").mode).toBe("invalid");
    expect(nameShape("json-parse-error").mode).toBe("failed");
  });

  it("prefers the longest suffix", () => {
    expect(nameShape("file-already-exists").mode).toBe("conflict");
    expect(nameShape("request-deadline-exceeded").mode).toBe("timeout");
  });

  it("finds a mode in the middle of a name", () => {
    expect(nameShape("resource-not-found-404").mode).toBe("absent");
  });

  it("leaves the object empty for a noun it does not know", () => {
    expect(nameShape("room-not-found")).toEqual({ mode: "absent", object: null, subject: null });
  });
});

describe("messageMode", () => {
  it("prefers the specific reading of a message", () => {
    expect(messageMode("value must be between 1 and 32")).toBe("range");
    expect(messageMode("name must not be null")).toBe("null");
    expect(messageMode("`prompt` is required")).toBe("absent");
    expect(messageMode("A bucket named foo already exists")).toBe("conflict");
    expect(messageMode("Invalid collation option")).toBe("invalid");
  });

  it("commits to nothing when the wording does not", () => {
    expect(messageMode("Signal Flow program returned code 7")).toBeNull();
  });
});

describe("contentFamily", () => {
  it("settles a family from a precise exception class, errno or status", () => {
    expect(contentFamily(page({ errorClass: "System.ArgumentNullException" }))).toEqual({
      family: "null-argument",
      source: "class",
    });
    expect(contentFamily(page({ errorMessage: "open ./x: ENOENT" }))).toEqual({
      family: "file-not-found",
      source: "errno",
    });
    expect(contentFamily(page({ httpStatus: 429 }))).toEqual({ family: "rate-limit-exceeded", source: "http" });
  });

  it("does not trust classes libraries throw for everything", () => {
    for (const errorClass of ["IllegalStateException", "InvalidOperationException", "TypeError", "ValueError", "Error"]) {
      expect(contentFamily(page({ errorClass })), errorClass).toBeNull();
    }
  });

  it("does not read a family into statuses whose meaning is the library's", () => {
    for (const httpStatus of [400, 422, 500]) expect(contentFamily(page({ httpStatus }))).toBeNull();
  });

  it("settles nothing when two signals on one page disagree", () => {
    expect(contentFamily(page({ errorClass: "FileNotFoundError", httpStatus: 403 }))).toBeNull();
  });

  it("only ever names a declared family", () => {
    for (const f of CONTENT_RULE_FAMILIES) expect(CANONICAL_TAGS.has(f), f).toBe(true);
  });
});
