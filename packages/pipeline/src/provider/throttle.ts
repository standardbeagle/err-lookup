import type { LlmProvider, InvokeOptions, ProviderResult } from "./types.js";

/** Anything that hands out a slot and a release — in-process Semaphore or the
 *  machine-wide MachineGate. */
export interface CallGate {
  acquire(): Promise<() => void>;
}

/**
 * Caps concurrent calls across every provider sharing one gate.
 *
 * The two concurrency knobs bound repos and per-phase batches separately, so
 * the peak call count is their product — a number that has to be set
 * conservatively to stay under a provider's rate limit, and that leaves slots
 * idle whenever a repo is cloning or between phases. One shared gate lets those
 * knobs over-subscribe: work fills the limit instead of multiplying up to it.
 */
export class ThrottledProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly gate: CallGate
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async invoke(prompt: string, opts: InvokeOptions): Promise<ProviderResult> {
    const release = await this.gate.acquire();
    try {
      return await this.inner.invoke(prompt, opts);
    } finally {
      release();
    }
  }
}
