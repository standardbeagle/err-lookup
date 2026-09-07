import { loadConfig, type ErrlookupConfig, type ProviderConfig } from "./config/index.js";
import { SpawningProvider } from "./provider/spawn.js";
import { AcpProvider } from "./provider/acp.js";
import { ThrottledProvider } from "./provider/throttle.js";
import { MachineGate } from "./util/machine-gate.js";
import type { LlmProvider } from "./provider/types.js";

/**
 * Build the real provider map from the loaded config: SpawningProvider for plain
 * CLIs, AcpProvider for `type "acp"` entries (e.g. opencode). Tests inject their
 * own fixture provider map instead.
 *
 * When `provider-max-concurrent` is set, every provider shares one gate sized to
 * the account's published rate limit. That is the only place the real ceiling
 * can be enforced — repo and batch concurrency bound their own layer, and their
 * product is a worst case rather than the actual number of calls in flight.
 *
 * The gate is MACHINE-wide (slot dirs under /tmp), not per-process: z.ai
 * throttles the account, and a drain plus a reverify sweep each honouring the
 * limit privately put double the ceiling in flight — the rate-limit storms of
 * 2026-09-01/02 abandoned 68 sweep batches and failed 5 scan repos that way.
 */
export function buildProviders(cfg = loadConfig()): Record<string, LlmProvider> {
  const limit = cfg.defaults.providerMaxConcurrent;
  const gate = limit > 0 ? new MachineGate(limit) : null;
  const out: Record<string, LlmProvider> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    const routed = { ...p, baseUrl: proxyBaseUrl(cfg, p) ?? p.baseUrl };
    const provider = routed.type === "acp" ? new AcpProvider(name, routed) : new SpawningProvider(name, routed);
    out[name] = gate ? new ThrottledProvider(provider, gate) : provider;
  }
  return out;
}

/**
 * The proxy's address for a provider whose upstream it records, or null to
 * leave the provider talking to the real endpoint.
 *
 * Routing is decided per opencode PROVIDER id (the part of the model id
 * before the first "/"), not per errlookup provider name: `flash`,
 * `flash-review` and `glm53` are three entries against one z.ai account, and
 * it is the account the rate limit belongs to. An explicit `base-url` in the
 * KDL wins — that knob exists to point one run somewhere else.
 */
export function proxyBaseUrl(cfg: ErrlookupConfig, p: ProviderConfig): string | null {
  if (!cfg.proxy.enabled || p.type !== "acp" || p.baseUrl) return null;
  const slash = p.model?.indexOf("/") ?? -1;
  if (slash <= 0) return null;
  const providerId = p.model!.slice(0, slash);
  if (!cfg.proxy.providerIds.includes(providerId)) return null;
  return `http://${cfg.proxy.host}:${cfg.proxy.port}`;
}
