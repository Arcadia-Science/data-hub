import { describe, expect, it } from "vitest";
import {
  canReprocessFile,
  type ReprocessableFile,
} from "@/lib/runs/reprocessable-statuses";
import { stalledProcessingAfterMs } from "@/lib/runs/stalled-processing";

const rawCompleted: ReprocessableFile = {
  category: "raw",
  deletedAt: null,
  processingStartedAt: null,
  s3Key: "dishcam/run/stack.tif",
  status: "completed",
};

describe("canReprocessFile", () => {
  it("allows a completed raw file on a processable instrument", () => {
    expect(canReprocessFile(rawCompleted, "dishcam")).toBe(true);
  });

  it("rejects processed artifacts even when status and S3 look eligible", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          category: "processed",
          s3Key: "dishcam/run/stack.jpg",
          status: "uploaded",
        },
        "dishcam"
      )
    ).toBe(false);
  });

  it("rejects detected files, missing S3, and unprocessable types", () => {
    expect(
      canReprocessFile({ ...rawCompleted, status: "detected" }, "dishcam")
    ).toBe(false);
    expect(canReprocessFile({ ...rawCompleted, s3Key: null }, "dishcam")).toBe(
      false
    );
    expect(canReprocessFile(rawCompleted, "generic")).toBe(false);
  });

  it("rejects a fresh processing file", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          processingStartedAt: new Date(),
        },
        "dishcam"
      )
    ).toBe(false);
  });

  it("allows a processing file past the stall window", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          processingStartedAt: new Date(
            Date.now() - stalledProcessingAfterMs() - 1000
          ),
        },
        "dishcam"
      )
    ).toBe(true);
  });

  it("allows a processing file with no processingStartedAt", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          processingStartedAt: null,
        },
        "dishcam"
      )
    ).toBe(true);
  });

  it("uses the server-stamped stalledProcessing flag when present", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          processingStartedAt: new Date(),
          stalledProcessing: true,
        },
        "dishcam"
      )
    ).toBe(true);
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          processingStartedAt: null,
          stalledProcessing: false,
        },
        "dishcam"
      )
    ).toBe(false);
  });
});
