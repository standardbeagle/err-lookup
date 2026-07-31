import { defineConfig } from "astro/config";

// Static output only (§6). One domain. Content sourced at build time from /data.
export default defineConfig({
  site: "https://errors.standardbeagle.com",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  compressHTML: true,
});
