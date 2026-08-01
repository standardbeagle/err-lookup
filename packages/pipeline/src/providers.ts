import { loadConfig } from "./config/index.js";
import { SpawningProvider } from "./provider/spawn.js";
import { AcpProvider } from "./provider/acp.js";
import type { LlmProvider } from "./provider/types.js";

/**
 * Build the real provider map from the loaded config: SpawningProvider for plain
 * CLIs, AcpProvider for `type "acp"` entries (e.g. opencode). Tests inject their
 * own fixture provider map instead.
 */
export function buildProviders(cfg = loadConfig()): Record<string, LlmProvider> {
  const out: Record<string, LlmProvider> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    out[name] = p.type === "acp" ? new AcpProvider(name, p) : new SpawningProvider(name, p);
  }
  return out;
}
