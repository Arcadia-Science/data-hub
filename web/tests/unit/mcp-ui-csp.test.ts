import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  authBaseURL: "http://localhost:3000",
}));

import { resetRunReportUiCspWarnings, runReportUiMeta } from "@/lib/mcp/ui-csp";

describe("runReportUiMeta", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The warned-var set is module state, so a leaked entry would make the
    // "warns once" test pass for the wrong reason.
    resetRunReportUiCspWarnings();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {
      // Silence expected warnings; individual tests assert on the spy.
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // A run's files split across both buckets, so leaving either one out breaks
  // half the report.
  it("names the raw and processed bucket origins", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("AWS_REGION", "us-west-1");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");
    vi.stubEnv("S3_PROCESSED_BUCKET", "processed-bucket");

    const csp = runReportUiMeta().ui.csp;
    expect(csp.resourceDomains).toEqual([
      "https://raw-bucket.s3.us-west-1.amazonaws.com",
      "https://processed-bucket.s3.us-west-1.amazonaws.com",
    ]);
    expect(csp.frameDomains).toEqual(csp.resourceDomains);
    // The View reads CSV and JSON bodies from S3 itself.
    expect(csp.connectDomains).toEqual(csp.resourceDomains);
    expect(runReportUiMeta().ui.prefersBorder).toBe(true);
  });

  it("leaves the archives bucket out", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");
    vi.stubEnv("S3_ARCHIVES_BUCKET", "archives-bucket");

    expect(runReportUiMeta().ui.csp.resourceDomains).not.toContain(
      "https://archives-bucket.s3.us-west-1.amazonaws.com"
    );
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

  // Without this an unset bucket is invisible: the policy just omits the
  // origin and files from it fail to load inside someone else's chat client.
  it("warns for a bucket that has no environment variable", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");
    vi.stubEnv("S3_PROCESSED_BUCKET", "");

    runReportUiMeta();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("S3_PROCESSED_BUCKET is not set");
  });

  // This runs once per MCP request, so warning every time would bury it.
  it("warns once per process, not once per call", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "");
    vi.stubEnv("S3_PROCESSED_BUCKET", "");

    runReportUiMeta();
    runReportUiMeta();
    runReportUiMeta();

    // One per variable, not one per call.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when both buckets are set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOCAL_S3_MIRROR", "");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "raw-bucket");
    vi.stubEnv("S3_PROCESSED_BUCKET", "processed-bucket");

    runReportUiMeta();

    expect(warn).not.toHaveBeenCalled();
  });

  // The mirror replaces both buckets, so the variables are genuinely unused.
  it("stays quiet when the local mirror is serving bytes", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_S3_MIRROR", "../lambda/.local-s3");
    vi.stubEnv("S3_RAW_DATA_BUCKET", "");
    vi.stubEnv("S3_PROCESSED_BUCKET", "");

    runReportUiMeta();

    expect(warn).not.toHaveBeenCalled();
  });
});
