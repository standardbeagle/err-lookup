import { describe, it, expect } from "vitest";
import { bingSiteAuthXml } from "../src/data/webmaster.js";

describe("bingSiteAuthXml", () => {
  it("renders the document shape Bing's XML-file check expects", () => {
    expect(bingSiteAuthXml("ABC123")).toBe(
      '<?xml version="1.0"?>\n<users>\n  <user>ABC123</user>\n</users>\n'
    );
  });

  // Bing hands out an uppercase hex string; it is echoed verbatim rather than
  // normalised, because the check is an exact string comparison on their side.
  it("echoes the token verbatim", () => {
    expect(bingSiteAuthXml("0a1B2c3D")).toContain("<user>0a1B2c3D</user>");
  });
});
