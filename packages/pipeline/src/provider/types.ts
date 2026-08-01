/** Provider invocation result. `parsed` is the JSON value extracted from raw stdout. */
export type ProviderResult =
  | { ok: true; raw: string; parsed: unknown }
  | { ok: false; kind: "spawn" | "parse" | "timeout" | "empty"; error: string };

export interface InvokeOptions {
  /** Working directory for the subprocess (typically the cloned repo). */
  cwd: string;
  /** Override the provider's configured timeout for this single call. */
  timeoutMs?: number;
  /**
   * When set, the prompt instructs the agent to write its JSON here and the
   * provider parses this file instead of scraping stdout. Missing file = failure
   * (never silently fall back to fabricated output).
   */
  outputFile?: string;
}

export interface LlmProvider {
  readonly name: string;
  invoke(prompt: string, opts: InvokeOptions): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  constructor(
    public readonly kind: "spawn" | "parse" | "timeout" | "empty",
    message: string,
    public readonly provider: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
