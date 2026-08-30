import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

import { runReportUiMeta } from "@/lib/mcp/ui-csp";

describe("runReportUiMeta", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names both bucket origins and leaves connectDomains empty", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("AWS_REGION", "us-west-1");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");
    vi.stubEnv("S3_ARCHIVES_BUCKET", "archives-bucket");

    const meta = runReportUiMeta();
    expect(meta.ui.csp.resourceDomains).toEqual([
      "https://raw-bucket.s3.us-west-1.amazonaws.com",
      "https://archives-bucket.s3.us-west-1.amazonaws.com",
    ]);
    expect(meta.ui.csp.frameDomains).toEqual(meta.ui.csp.resourceDomains);
    expect(meta.ui.csp.connectDomains).toEqual([]);
    expect(meta.ui.prefersBorder).toBe(true);
  });

  it("adds local origins outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_S3_MIRROR", "");

    expect(runReportUiMeta().ui.csp.resourceDomains).toEqual(
      expect.arrayContaining(["http://localhost:3000", "http://127.0.0.1:3000"])
    );
  });

  it("skips the S3 hosts when the local mirror is serving bytes", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_S3_MIRROR", "../lambda/.local-s3");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");

    const domains = runReportUiMeta().ui.csp.resourceDomains;
    expect(domains).not.toContain(
      "https://raw-bucket.s3.us-west-1.amazonaws.com"
    );
    expect(domains).toContain("http://localhost:3000");
  });

  // The listing and the body are built from the same synchronous call, so a
  // cold instance cannot advertise one policy and then serve another.
  it("returns the same policy on every call", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");

    expect(runReportUiMeta()).toEqual(runReportUiMeta());
  });
});
