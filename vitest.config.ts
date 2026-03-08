import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: "forks",
    include: ["tests/e2e/**/*.test.ts"],
  },
});
