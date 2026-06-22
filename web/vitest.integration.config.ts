import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: "tests/integration/global-setup.ts",
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
