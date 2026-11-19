import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketForCategory,
  runFileLocationError,
  runFileS3Key,
} from "@/lib/api/run-file-location";

const RAW = "raw-bucket";
const PROCESSED = "processed-bucket";

function location(
  overrides: Partial<Parameters<typeof runFileLocationError>[0]> = {}
) {
  return {
    instrumentId: "plate-reader",
    runId: "run-1",
    filename: "data.csv",
    category: "raw" as const,
    expectedBucket: RAW,
    s3Bucket: RAW,
    s3Key: "plate-reader/run-1/data.csv",
    ...overrides,
  };
}

describe("runFileLocationError", () => {
  it("accepts the file's own key in its category's bucket", () => {
    expect(runFileLocationError(location())).toBeNull();
    expect(
      runFileLocationError(
        location({
          category: "processed",
          expectedBucket: PROCESSED,
          s3Bucket: PROCESSED,
        })
      )
    ).toBeNull();
  });

  it("names the key it expected", () => {
    expect(
      runFileLocationError(location({ s3Key: "other/run-1/data.csv" }))
    ).toBe("s3_key must be 'plate-reader/run-1/data.csv'");
  });

  it("refuses a bucket other than the category's", () => {
    expect(runFileLocationError(location({ s3Bucket: PROCESSED }))).toBe(
      "s3_bucket must be Data Hub's raw bucket for a raw file"
    );
  });

  // Run IDs may contain '/'. A slash in the filename could otherwise let run
  // `a` register a key that is run `a/b`'s.
  it("keeps a run whose ID is a prefix of another's out of that run's folder", () => {
    expect(
      runFileLocationError(
        location({
          runId: "a",
          filename: "b/data.csv",
          s3Key: "plate-reader/a/b/data.csv",
        })
      )
    ).toBe("filename must not contain '/'");
    expect(
      runFileLocationError(
        location({
          runId: "a/b",
          filename: "data.csv",
          s3Key: "plate-reader/a/b/data.csv",
        })
      )
    ).toBeNull();
  });

  it("compares the run ID exactly, characters and spaces included", () => {
    const runId = "Plate #3 50%?";
    expect(
      runFileLocationError(
        location({
          runId,
          s3Key: runFileS3Key("plate-reader", runId, "data.csv"),
        })
      )
    ).toBeNull();
    expect(
      runFileLocationError(
        location({ runId: "RUN1", s3Key: "plate-reader/ RUN1 /data.csv" })
      )
    ).toBe("s3_key must be 'plate-reader/RUN1/data.csv'");
  });
});

describe("bucketForCategory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads each category's bucket", () => {
    vi.stubEnv("S3_RAW_DATA_BUCKET", RAW);
    vi.stubEnv("S3_PROCESSED_BUCKET", PROCESSED);
    expect(bucketForCategory("raw")).toBe(RAW);
    expect(bucketForCategory("processed")).toBe(PROCESSED);
  });

  it("throws when the processed bucket is unset", () => {
    vi.stubEnv("S3_RAW_DATA_BUCKET", RAW);
    vi.stubEnv("S3_PROCESSED_BUCKET", "");
    expect(bucketForCategory("raw")).toBe(RAW);
    expect(() => bucketForCategory("processed")).toThrow(
      "S3_PROCESSED_BUCKET environment variable is not set"
    );
  });
});
