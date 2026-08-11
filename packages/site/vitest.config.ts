import { getViteConfig } from "astro/config";

// getViteConfig loads the Astro vite plugins so tests can render .astro
// components through the container API (error pages no longer exist in dist).
export default getViteConfig(
  {
    test: {
      include: ["tests/**/*.test.ts"],
      environment: "node",
      testTimeout: 90000,
      // Suites that assert on the built site run `astro build` into the same
      // dist/. In parallel they would overwrite each other's output mid-read.
      fileParallelism: false,
    },
  },
  // Do not load astro.config.mjs: the Cloudflare adapter's hooks expect a
  // workers build context and crash vitest's config load. Component rendering
  // through the container needs only the default Astro plugins.
  { configFile: false }
);
