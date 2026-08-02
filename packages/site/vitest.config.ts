import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 90000,
    // Suites that assert on the built site run `astro build` into the same
    // dist/. In parallel they would overwrite each other's output mid-read.
    fileParallelism: false,
  },
});
