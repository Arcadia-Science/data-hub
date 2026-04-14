import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/mcp/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
