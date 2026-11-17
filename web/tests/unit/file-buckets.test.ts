import { describe, expect, it } from "vitest";
import { fileStatusEnum } from "@/lib/db/schema";
import {
  type FileStatus,
  IN_S3_FILE_STATUSES,
  PRE_UPLOAD_FILE_STATUSES,
  REQUESTABLE_FILE_STATUSES,
  RUN_BUCKET_BY_FILE_STATUS,
  runBucketForFile,
  runBucketSources,
  UPLOAD_STAGE_BY_FILE_STATUS,
} from "@/lib/runs/file-buckets";
import { RUN_FILE_BUCKETS, RUN_STATUS_VALUES } from "@/lib/runs/run-status";

// The tables are typed against the enum, so a missing status already fails to
// compile. These tests guard the rest of the contract: each file status counts
// in exactly one run status, and each run status has a file status behind it.

const ALL_STATUSES = fileStatusEnum.enumValues as readonly FileStatus[];

describe("RUN_BUCKET_BY_FILE_STATUS", () => {
  it("has a row for every file status and nothing else", () => {
    expect(Object.keys(RUN_BUCKET_BY_FILE_STATUS).sort()).toEqual(
      [...ALL_STATUSES].sort()
    );
  });

  it("gives every file-backed run status at least one source", () => {
    for (const bucket of RUN_FILE_BUCKETS) {
      const sources = runBucketSources(bucket);
      expect(
        sources.statuses.length +
          sources.processing.length +
          sources.detected.length,
        `no file status counts toward '${bucket}'`
      ).toBeGreaterThan(0);
    }
  });

  it("counts each file status in exactly one run status", () => {
    const seen = new Map<string, string>();
    const note = (key: string, bucket: string) => {
      expect(seen.has(key), `'${key}' counts twice`).toBe(false);
      seen.set(key, bucket);
    };
    for (const bucket of RUN_FILE_BUCKETS) {
      const sources = runBucketSources(bucket);
      for (const status of sources.statuses) {
        note(status, bucket);
      }
      for (const half of sources.processing) {
        note(`processing:${half}`, bucket);
      }
      for (const half of sources.detected) {
        note(`detected:${half}`, bucket);
      }
    }
    const expected = ALL_STATUSES.flatMap((status) => {
      if (status === "processing") {
        return ["processing:inFlight", "processing:stalled"];
      }
      if (status === "detected") {
        return ["detected:autoUploadExpected", "detected:otherwise"];
      }
      return [status];
    });
    expect([...seen.keys()].sort()).toEqual(expected.sort());
  });

  it("splits processing and detected into two different run statuses each", () => {
    const { inFlight, stalled } = RUN_BUCKET_BY_FILE_STATUS.processing;
    expect(inFlight).not.toBe(stalled);
    const { autoUploadExpected, otherwise } =
      RUN_BUCKET_BY_FILE_STATUS.detected;
    expect(autoUploadExpected).not.toBe(otherwise);
  });

  it("maps the upload states", () => {
    expect(runBucketSources("waiting_upload")).toEqual({
      detected: ["autoUploadExpected"],
      processing: [],
      statuses: ["upload_requested"],
    });
    expect(runBucketSources("not_uploaded")).toEqual({
      detected: ["otherwise"],
      processing: [],
      statuses: [],
    });
    expect(runBucketSources("upload_failed")).toEqual({
      detected: [],
      processing: [],
      statuses: ["upload_failed"],
    });
  });

  it("keeps the processing states", () => {
    expect(runBucketSources("processing")).toEqual({
      detected: [],
      processing: ["inFlight"],
      statuses: [],
    });
    expect(runBucketSources("stalled")).toEqual({
      detected: [],
      processing: ["stalled"],
      statuses: [],
    });
    for (const bucket of [
      "uploaded",
      "queued",
      "completed",
      "failed",
    ] as const) {
      expect(runBucketSources(bucket)).toEqual({
        detected: [],
        processing: [],
        statuses: [bucket],
      });
    }
  });
});

describe("runBucketForFile", () => {
  const row = (
    status: FileStatus,
    extra: { autoUploadExpectedAt?: Date | null; stalledProcessing?: boolean }
  ) => ({
    autoUploadExpectedAt: null,
    stalledProcessing: false,
    status,
    ...extra,
  });

  it("agrees with runBucketSources for every file state", () => {
    for (const bucket of RUN_FILE_BUCKETS) {
      const sources = runBucketSources(bucket);
      for (const status of sources.statuses) {
        expect(runBucketForFile(row(status, {}))).toBe(bucket);
      }
      for (const half of sources.processing) {
        expect(
          runBucketForFile(
            row("processing", { stalledProcessing: half === "stalled" })
          )
        ).toBe(bucket);
      }
      for (const half of sources.detected) {
        expect(
          runBucketForFile(
            row("detected", {
              autoUploadExpectedAt:
                half === "autoUploadExpected" ? new Date() : null,
            })
          )
        ).toBe(bucket);
      }
    }
  });
});

describe("RUN_FILE_BUCKETS", () => {
  it("is the run-status priority order without 'empty'", () => {
    expect(RUN_FILE_BUCKETS).toEqual(
      RUN_STATUS_VALUES.filter((status) => status !== "empty")
    );
  });
});

describe("upload stages", () => {
  it("has a stage for every file status and nothing else", () => {
    expect(Object.keys(UPLOAD_STAGE_BY_FILE_STATUS).sort()).toEqual(
      [...ALL_STATUSES].sort()
    );
  });

  it("splits the statuses into pre-upload and in-S3 with no overlap", () => {
    expect(
      PRE_UPLOAD_FILE_STATUSES.filter((status) =>
        IN_S3_FILE_STATUSES.includes(status)
      )
    ).toEqual([]);
    expect(
      [...PRE_UPLOAD_FILE_STATUSES, ...IN_S3_FILE_STATUSES].sort()
    ).toEqual([...ALL_STATUSES].sort());
  });

  it("keeps upload_failed files with those still on the instrument PC", () => {
    expect([...REQUESTABLE_FILE_STATUSES].sort()).toEqual([
      "detected",
      "upload_failed",
    ]);
    expect([...PRE_UPLOAD_FILE_STATUSES].sort()).toEqual([
      "detected",
      "upload_failed",
      "upload_requested",
    ]);
  });
});
