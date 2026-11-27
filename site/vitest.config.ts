import { getViteConfig } from "astro/config";

// getViteConfig loads the Astro vite plugins so tests can render .astro
// components through the container API (error pages no longer exist in dist).
export default getViteConfig(
  {
    test: {
      include: ["tests/**/*.test.ts"],
      environment: "node",
      testTimeout: 90000,
      // One build for the whole suite, before any file runs. Suites used to
      // build the site themselves — three builds of one fixture — and had to
      // run serially so they would not overwrite each other's dist mid-read.
      globalSetup: "./tests/global-setup.ts",
    },
  },
  // Do not load astro.config.mjs: the Cloudflare adapter's hooks expect a
  // workers build context and crash vitest's config load. Component rendering
  // through the container needs only the default Astro plugins.
  { configFile: false }
);
