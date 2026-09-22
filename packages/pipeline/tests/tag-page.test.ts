import { describe, it, expect } from "vitest";
import type { CanonicalFamily } from "@errlookup/schema";
import { openDb } from "../src/db/client.js";
import { errors } from "../src/db/schema.js";
import { TypeSafeClient } from "../src/provider/typesafe.js";
import {
  pageState,
  pageQuestion,
  domainQuestion,
  classifyPagesFlat,
  classifyPagesTwoStage,
  samplePages,
  NO_FAMILY,
  type Page,
} from "../src/phase/tag-page.js";
import { errorRow } from "./error-row.js";
import { tmpDbPath } from "./setup.js";

const page = (id: string, over: Partial<Page> = {}): Page => ({
  id,
  repo: "org/lib",
  errorMessage: "FOO is required",
  errorClass: "ValueError",
  errorCode: null,
  httpStatus: null,
  errorType: "validation",
  documentation: "Raised when FOO is unset.",
  triggerScenarios: null,
  commonSituations: null,
  proposal: "missing-env-var",
  ...over,
});

const FAMILIES: CanonicalFamily[] = [
  { tag: "missing-env-var", domain: "configuration", criteria: "A required environment variable is unset." },
  { tag: "file-not-found", domain: "filesystem", criteria: "A file does not exist at the path given." },
];

describe("pageState", () => {
  it("shows only the requested sections", () => {
    expect(pageState(page("a"), ["message"])).toEqual({ error_message: "FOO is required" });
    expect(pageState(page("a"), ["message", "signals", "proposal"])).toEqual({
      error_message: "FOO is required",
      exception_class: "ValueError",
      proposed_family_name: "missing-env-var",
    });
  });

  it("leaves a missing section out instead of sending it empty", () => {
    // An empty "triggered_when" would tell the model the page has none,
    // when it was simply not written.
    expect(pageState(page("a"), ["triggers", "situations"])).toEqual({});
  });
});

describe("questions", () => {
  it("offers every family and a way out", () => {
    const q = pageQuestion(FAMILIES, "pages[0]");
    expect(Object.keys(q.criteria)).toEqual(["missing-env-var", "file-not-found", NO_FAMILY]);
    expect(q.instructions).toContain("`pages[0]`");
  });

  it("groups families by domain for the first of two stages", () => {
    const q = domainQuestion(FAMILIES, "page");
    expect(Object.keys(q.criteria)).toEqual(["configuration", "filesystem", NO_FAMILY]);
    expect(q.criteria.configuration).toContain("missing-env-var");
  });
});

/** A Jev stand-in that answers every question with a scripted choice per page index. */
function jev(choices: (question: string, body: { questions: Record<string, { criteria: Record<string, string> }> }) => string) {
  const requests: unknown[] = [];
  const fetchImpl = async (_url: unknown, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => {
        const choice = choices(k, body);
        return [k, { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9, [NO_FAMILY]: 0.1 } }];
      })
    );
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 1 } }));
  };
  return { client: new TypeSafeClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }), requests };
}

describe("classifying pages", () => {
  it("packs pages into one request and maps each answer back to its page", async () => {
    const { client, requests } = jev((k) => (k === "p1" ? "file-not-found" : "missing-env-var"));
    const out = await classifyPagesFlat(client, [page("a"), page("b")], ["message"], FAMILIES);
    expect(requests).toHaveLength(1);
    expect(out.map((d) => [d.id, d.choice])).toEqual([
      ["a", "missing-env-var"],
      ["b", "file-not-found"],
    ]);
    expect(out[0]!.runnerUp).toBe(NO_FAMILY);
  });

  it("reads 'none of these' as no family", async () => {
    const { client } = jev(() => NO_FAMILY);
    const [d] = await classifyPagesFlat(client, [page("a")], ["message"], FAMILIES);
    expect(d!.choice).toBeNull();
  });

  it("asks the second stage only about the chosen domain's families", async () => {
    const { client, requests } = jev((_k, body) => {
      const opts = Object.keys(Object.values(body.questions)[0]!.criteria);
      return opts.includes("filesystem") ? "filesystem" : "file-not-found";
    });
    const [d] = await classifyPagesTwoStage(client, [page("a")], ["message"], FAMILIES);
    expect(d!.choice).toBe("file-not-found");
    const second = requests[1] as { questions: { family: { criteria: Record<string, string> } } };
    expect(Object.keys(second.questions.family.criteria)).toEqual(["file-not-found", NO_FAMILY]);
  });
});

describe("samplePages", () => {
  it("draws the same pages for the same seed, and others for another", () => {
    const { db, raw } = openDb(tmpDbPath("sample"));
    try {
      for (let i = 0; i < 50; i++) db.insert(errors).values(errorRow()).run();
      const a = samplePages(db, 10, 7).map((p) => p.id);
      expect(samplePages(db, 10, 7).map((p) => p.id)).toEqual(a);
      expect(samplePages(db, 10, 8).map((p) => p.id)).not.toEqual(a);
      expect(new Set(a).size).toBe(10);
    } finally {
      raw.close();
    }
  });
});
