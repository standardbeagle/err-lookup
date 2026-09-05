import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onRequest } from "../src/server/api-handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "..", "public", "data");

// Fake ASSETS binding serving the fixture dataset like the deployed site would.
const env = {
  ASSETS: {
    async fetch(req: Request | string): Promise<Response> {
      const url = new URL(typeof req === "string" ? req : req.url);
      const file = join(dataDir, url.pathname.replace(/^\/data\//, ""));
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file), { headers: { "content-type": "application/json" } });
    },
  },
};

const call = (path: string) => onRequest({ request: new Request(`https://example.test${path}`), env });

describe("Pages Functions API", () => {
  it("search returns scored matches with CORS", async () => {
    const res = await call("/api/search?q=Request%20failed%20with%20status%20code%20404");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { matches: { repo: string; score: number }[]; datasetVersion: string };
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches[0]!.repo).toBe("axios/axios");
    expect(body.datasetVersion).toBeTruthy();
  });

  it("errors/:id returns the full record", async () => {
    const search = await call("/api/search?q=ERR_BAD_RESPONSE");
    const { matches } = (await search.json()) as { matches: { id: string }[] };
    const res = await call(`/api/errors/${matches[0]!.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { documentation: string } };
    expect(body.record.documentation.length).toBeGreaterThan(10);
  });

  it("tags returns the family vocabulary, and can return only the uncovered families", async () => {
    const res = await call("/api/tags");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tags: { tag: string; errorCount: number; infoSlug: string | null; infoUrl: string | null }[];
      total: number;
      covered: number;
    };
    expect(body.total).toBe(2);
    expect(body.covered).toBe(1);
    // Largest family first, and a covered family carries a usable link.
    expect(body.tags[0]!.tag).toBe("http-status-rejected");
    expect(body.tags[0]!.infoUrl).toContain("/info/err-bad-response/");
    expect(body.tags[1]!.infoUrl).toBeNull();

    const gap = (await (await call("/api/tags?uncovered=1")).json()) as { tags: { tag: string }[] };
    expect(gap.tags.map((t) => t.tag)).toEqual(["type-assertion-failed"]);

    const big = (await (await call("/api/tags?minErrors=2")).json()) as { tags: { tag: string }[] };
    expect(big.tags.map((t) => t.tag)).toEqual(["http-status-rejected"]);
  });

  it("repos lists repositories; bad input 400s; unknown 404s; OPTIONS preflights", async () => {
    const repos = (await (await call("/api/repos")).json()) as { repos: unknown[] };
    expect(repos.repos.length).toBeGreaterThan(0);
    expect((await call("/api/search")).status).toBe(400);
    expect((await call("/api/nope")).status).toBe(404);
    const pre = await onRequest({ request: new Request("https://example.test/api/search", { method: "OPTIONS" }), env });
    expect(pre.status).toBe(204);
  });
});
