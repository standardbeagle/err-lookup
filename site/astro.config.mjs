import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// Hybrid output (§6 revised for corpus scale): everything prerenders except
// the per-error detail pages and the API — one static page per error stopped
// scaling at ~17k files against Pages' deployment file cap, and the build cost
// grew with the corpus. Long-tail pages render on demand in the worker from
// the same /data shards this deploy ships.
export default defineConfig({
  site: "https://errors.standardbeagle.com",
  // Tests that need a build with different settings (paging renders with one
  // repo per page) point this elsewhere, so they never disturb the shared
  // dist/ the other suites read. Before it existed, the paging suite restored
  // dist by rebuilding the whole site a second time in afterAll — one Astro
  // build to get its own fixture, another purely to put the directory back.
  outDir: process.env.ERRLOOKUP_OUT_DIR || undefined,
  output: "static",
  adapter: cloudflare({ imageService: "passthrough" }),
  // "ignore", not "always": with on-demand routes Astro applies the trailing-
  // slash policy to server endpoints too, and /api/search (the published API
  // contract) must not 308-redirect. Page canonicals keep the slash form.
  trailingSlash: "ignore",
  build: {
    format: "directory",
  },
  compressHTML: true,
});
