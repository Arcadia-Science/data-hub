import { describe, expect, it } from "vitest";
import { fileStatusEnum } from "@/lib/db/schema";
import {
  type FileStatus,
  IN_S3_FILE_STATUSES,
  PRE_UPLOAD_FILE_STATUSES,
  RUN_BUCKET_BY_FILE_STATUS,
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
        sources.statuses.length + sources.processing.length,
        `no file status counts toward '${bucket}'`
      ).toBeGreaterThan(0);
    }
  });

  it("counts each file status in exactly one run status", () => {
    const seen = new Map<string, string>();
    for (const bucket of RUN_FILE_BUCKETS) {
      const sources = runBucketSources(bucket);
      for (const status of sources.statuses) {
        expect(seen.has(status), `'${status}' counts twice`).toBe(false);
        seen.set(status, bucket);
      }
      for (const half of sources.processing) {
        const key = `processing:${half}`;
        expect(seen.has(key), `'${key}' counts twice`).toBe(false);
        seen.set(key, bucket);
      }
    }
    const expected = ALL_STATUSES.flatMap((status) =>
      status === "processing"
        ? ["processing:inFlight", "processing:stalled"]
        : [status]
    );
    expect([...seen.keys()].sort()).toEqual(expected.sort());
  });

  it("splits processing into two different run statuses", () => {
    const { inFlight, stalled } = RUN_BUCKET_BY_FILE_STATUS.processing;
    expect(inFlight).not.toBe(stalled);
  });

  it("keeps today's mapping", () => {
    expect(runBucketSources("pending")).toEqual({
      processing: [],
      statuses: ["detected", "upload_requested"],
    });
    expect(runBucketSources("processing")).toEqual({
      processing: ["inFlight"],
      statuses: [],
    });
    expect(runBucketSources("stalled")).toEqual({
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
        processing: [],
        statuses: [bucket],
      });
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

  it("keeps today's split", () => {
    expect([...PRE_UPLOAD_FILE_STATUSES].sort()).toEqual([
      "detected",
      "upload_requested",
    ]);
  });
});
