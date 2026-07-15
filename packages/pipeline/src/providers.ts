import { loadConfig } from "./config/index.js";
import { SpawningProvider } from "./provider/spawn.js";
import type { LlmProvider } from "./provider/types.js";

/**
 * Build the real provider map from the loaded config: one SpawningProvider per
 * configured provider. Tests inject their own fixture provider map instead.
 */
export function buildProviders(cfg = loadConfig()): Record<string, LlmProvider> {
  const out: Record<string, LlmProvider> = {};
  for (const [name, p] of Object.entries(cfg.providers)) {
    out[name] = new SpawningProvider(name, p);
  }
  return out;
}
