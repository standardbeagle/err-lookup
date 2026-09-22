/**
 * TypeSafe System One client — the typed-decision route used to map coined
 * background-family names onto the canonical taxonomy.
 *
 * It is deliberately not an `LlmProvider`. The agent providers in this folder
 * spawn a CLI, hand it a prompt and parse whatever JSON comes back out of
 * prose; the failure modes that shape them — invented fields, truncated
 * objects, a model answering in Markdown — cannot happen here, because the
 * answer is constrained to the options the request declares. A classification
 * is one HTTP call with a fixed answer shape, so it gets its own small client
 * rather than a place in an abstraction built for the other problem.
 *
 * The model is pinned rather than aliased. `jev-latest` moves when TypeSafe
 * releases, and the confidence threshold in `phase/tag-classify.ts` is tuned
 * against a specific version's calibration; a silent model change would move
 * the decisions without moving the code that reviews them. The version that
 * answered is recorded with every decision.
 */

/** Pinned model. Bump deliberately, and re-check the confidence gate when you do. */
export const JEV_MODEL = "jev-1.13.0";

const API_URL = "https://api.typesafe.ai/v1/systemone";

/** One option set to pick from: option name → what that option means. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | null>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface EvaluateResult {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export class TypeSafeError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "TypeSafeError";
  }
}

export interface TypeSafeOptions {
  apiKey?: string;
  model?: string;
  url?: string;
  /** Hard ceiling on one call, including retries of a rate-limited request. */
  timeoutMs?: number;
  /** Attempts for a retryable status (429/529) before giving up. */
  maxAttempts?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Tokens billed across every call this client has made. */
  public inputTokens = 0;
  public outputTokens = 0;
  public calls = 0;

  constructor(opts: TypeSafeOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    // No key means no classification. Falling back to the coined name is what
    // produced the sprawl this whole path exists to end, so it fails instead.
    if (!apiKey) {
      throw new TypeSafeError(
        "TYPESAFE_API_KEY is not set — run the command under `devkey run typesafe -- …`"
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? JEV_MODEL;
    this.url = opts.url ?? process.env.ERRLOOKUP_TYPESAFE_URL ?? API_URL;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /**
   * Evaluate one state against a map of questions. Questions over the same
   * state travel together: the model reads the state once and answers them in
   * parallel, so a second request only pays off when its questions depend on
   * this one's answers.
   */
  async evaluate(
    state: string | Record<string, unknown>,
    questions: Record<string, ChoiceQuestion>
  ): Promise<EvaluateResult> {
    const body = JSON.stringify({ state, model: this.model, questions });
    let lastError = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.post(body);
      if (res.ok) {
        const parsed = (await res.json()) as EvaluateResult;
        this.calls++;
        this.inputTokens += parsed.usage?.input_tokens ?? 0;
        this.outputTokens += parsed.usage?.output_tokens ?? 0;
        return parsed;
      }
      const text = await res.text().catch(() => "");
      lastError = `${res.status} ${text.slice(0, 400)}`;
      if (!RETRYABLE.has(res.status) || attempt === this.maxAttempts) {
        throw new TypeSafeError(`TypeSafe call failed: ${lastError}`, res.status);
      }
      // Honour the server's own timing when it sends one; it knows when the
      // window reopens and a guessed backoff just burns attempts.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 500 * 2 ** (attempt - 1));
      await this.sleep(waitMs);
    }
    throw new TypeSafeError(`TypeSafe call failed after ${this.maxAttempts} attempts: ${lastError}`);
  }

  private async post(body: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      throw new TypeSafeError(`TypeSafe request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Input-token cost in USD at the published Jev 1.13 rate ($0.042 per million). */
export function jevCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.042;
}
