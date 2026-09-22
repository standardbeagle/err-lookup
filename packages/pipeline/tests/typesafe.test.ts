import { describe, it, expect, vi } from "vitest";
import { TypeSafeClient, TypeSafeError, JEV_MODEL, jevCostUsd } from "../src/provider/typesafe.js";

function answer(choice: string): Response {
  return new Response(
    JSON.stringify({
      model: JEV_MODEL,
      answers: {
        family: { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.8 },
      },
      usage: { input_tokens: 300, output_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const question = {
  type: "choice" as const,
  instructions: "Which family?",
  criteria: { "file-not-found": "missing file", "permission-denied": "not allowed" },
};

describe("TypeSafeClient", () => {
  it("refuses to run without a key rather than guessing", () => {
    expect(() => new TypeSafeClient({ apiKey: "" })).toThrow(TypeSafeError);
  });

  it("sends the pinned model and the bearer key, and tallies usage", async () => {
    const fetchImpl = vi.fn(async () => answer("file-not-found"));
    const client = new TypeSafeClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await client.evaluate("ENOENT: no such file", { family: question });

    expect(res.answers.family?.choice).toBe("file-not-found");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe(JEV_MODEL);
    expect(client.inputTokens).toBe(300);
    expect(client.calls).toBe(1);
  });

  it("retries a rate limit on the server's own schedule", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(answer("permission-denied"));
    const sleep = vi.fn(async () => {});
    const client = new TypeSafeClient({
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const res = await client.evaluate("EACCES", { family: question });

    expect(res.answers.family?.choice).toBe("permission-denied");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up with the status attached instead of returning a guess", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad question", { status: 422 }));
    const client = new TypeSafeClient({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.evaluate("x", { family: question })).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the attempt budget", async () => {
    const fetchImpl = vi.fn(async () => new Response("overloaded", { status: 529 }));
    const client = new TypeSafeClient({
      apiKey: "k",
      maxAttempts: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });

    await expect(client.evaluate("x", { family: question })).rejects.toThrow(TypeSafeError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("prices input tokens at the published rate", () => {
    expect(jevCostUsd(1_000_000)).toBeCloseTo(0.042, 6);
  });
});
