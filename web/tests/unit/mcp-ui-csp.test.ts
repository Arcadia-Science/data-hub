import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

vi.mock("@/lib/s3", () => ({
  getPresignedDownloadUrl: vi.fn(),
}));

import {
  resetRunReportUiCspCache,
  runReportUiMeta,
  runReportUiMetaSnapshot,
} from "@/lib/mcp/ui-csp";
import { getPresignedDownloadUrl } from "@/lib/s3";

describe("runReportUiMeta", () => {
  afterEach(() => {
    resetRunReportUiCspCache();
    vi.unstubAllEnvs();
    vi.mocked(getPresignedDownloadUrl).mockReset();
  });

  it("derives the S3 origin from a signed URL and leaves connectDomains empty", async () => {
    vi.stubEnv("S3_RAW_DATA_BUCKET", "dotted.bucket.name");
    vi.mocked(getPresignedDownloadUrl).mockResolvedValue(
      "https://s3.us-west-1.amazonaws.com/dotted.bucket.name/__mcp-app-csp-probe__"
    );

    const meta = await runReportUiMeta();
    expect(meta.ui.csp.resourceDomains).toEqual(
      expect.arrayContaining(["https://s3.us-west-1.amazonaws.com"])
    );
    expect(meta.ui.csp.frameDomains).toEqual(meta.ui.csp.resourceDomains);
    expect(meta.ui.csp.connectDomains).toEqual([]);
    expect(meta.ui.prefersBorder).toBe(true);
  });

  it("snapshots local origins before the probe finishes", () => {
    const snapshot = runReportUiMetaSnapshot();
    expect(snapshot.ui.csp.resourceDomains).toEqual(
      expect.arrayContaining(["http://localhost:3000"])
    );
    expect(snapshot.ui.csp.connectDomains).toEqual([]);
  });
});
