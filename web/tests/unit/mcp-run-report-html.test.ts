import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    statSync: vi.fn(actual.statSync),
  };
});

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

import {
  HELLO_WORLD_RUN_REPORT_HTML,
  loadRunReportHtml,
  resetRunReportHtmlCache,
} from "@/lib/mcp/run-report-html";

describe("loadRunReportHtml", () => {
  afterEach(() => {
    resetRunReportHtmlCache();
    vi.unstubAllEnvs();
    vi.mocked(existsSync).mockReset().mockReturnValue(false);
    vi.mocked(readFileSync).mockReset();
    vi.mocked(statSync).mockReset();
  });

  it("serves the placeholder in non-production when the artifact is missing", () => {
    vi.stubEnv("NODE_ENV", "test");
    const html = loadRunReportHtml();
    expect(html).toContain("Hello from the Data Hub run report view.");
    expect(html).toContain("http://localhost:3000");
    expect(html).not.toContain("%%DATA_HUB_ORIGIN%%");
    expect(HELLO_WORLD_RUN_REPORT_HTML).toContain("%%DATA_HUB_ORIGIN%%");
  });

  it("throws in production when the artifact is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    resetRunReportHtmlCache();
    expect(() => loadRunReportHtml()).toThrow(/mcp-apps:build/);
  });

  it("re-reads the artifact after a rebuild", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync)
      .mockReturnValueOnce({ mtimeMs: 1 } as import("node:fs").Stats)
      .mockReturnValueOnce({ mtimeMs: 1 } as import("node:fs").Stats)
      .mockReturnValue({ mtimeMs: 2 } as import("node:fs").Stats);
    vi.mocked(readFileSync)
      .mockReturnValueOnce("<html>v1 %%DATA_HUB_ORIGIN%%</html>")
      .mockReturnValue("<html>v2 %%DATA_HUB_ORIGIN%%</html>");

    expect(loadRunReportHtml()).toContain("v1");
    expect(loadRunReportHtml()).toContain("v1");
    expect(loadRunReportHtml()).toContain("v2");
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
