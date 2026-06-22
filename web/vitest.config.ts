import path from "path";
import { defineConfig } from "vitest/config";

// Fast unit-style suite — pure functions and in-memory MCP transport tests.
// No Postgres, no Next.js dev server, no global setup. The integration suite
// (vitest.integration.config.ts) covers the HTTP boundary.
export default defineConfig({
  test: {
    include: ["tests/mcp/**/*.test.ts", "tests/unit/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
});
