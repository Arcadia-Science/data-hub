import { describe, expect, it, vi } from "vitest";
import { mcpServerInfo } from "@/lib/mcp/server-info";

describe("MCP server info", () => {
  it("reports the plain version when there is no deployed commit", () => {
    expect(mcpServerInfo({})).toEqual({ name: "data-hub", version: "1.0.0" });
  });

  it("adds the first 7 characters of the commit as build metadata", () => {
    expect(
      mcpServerInfo({
        VERCEL_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
      })
    ).toEqual({ name: "data-hub", version: "1.0.0+0123456" });
  });

  it("keeps a commit that is already short", () => {
    expect(mcpServerInfo({ VERCEL_GIT_COMMIT_SHA: "abc12" }).version).toBe(
      "1.0.0+abc12"
    );
  });

  it("ignores an empty or blank commit", () => {
    expect(mcpServerInfo({ VERCEL_GIT_COMMIT_SHA: "" }).version).toBe("1.0.0");
    expect(mcpServerInfo({ VERCEL_GIT_COMMIT_SHA: "  " }).version).toBe(
      "1.0.0"
    );
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "fedcba9876543210");
    try {
      expect(mcpServerInfo().version).toBe("1.0.0+fedcba9");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
