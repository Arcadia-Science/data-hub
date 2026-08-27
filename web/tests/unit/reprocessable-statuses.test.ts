import { describe, expect, it } from "vitest";
import {
  canReprocessFile,
  type ReprocessableFile,
} from "@/lib/runs/reprocessable-statuses";

// `canReprocessFile` is the render-time gate for the Reprocess button. It
// never reads the clock: whether a `processing` file counts as stalled is
// decided on the server and arrives as `stalledProcessing`.

const rawCompleted: ReprocessableFile = {
  category: "raw",
  deletedAt: null,
  s3Key: "dishcam/run/stack.tif",
  stalledProcessing: false,
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

  it("rejects an in-flight processing file", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          stalledProcessing: false,
        },
        "dishcam"
      )
    ).toBe(false);
  });

  it("allows a processing file the server marked stalled", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          stalledProcessing: true,
        },
        "dishcam"
      )
    ).toBe(true);
  });

  it("still rejects a stalled file that fails the other gates", () => {
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          stalledProcessing: true,
          s3Key: null,
        },
        "dishcam"
      )
    ).toBe(false);
    expect(
      canReprocessFile(
        {
          ...rawCompleted,
          status: "processing",
          stalledProcessing: true,
          deletedAt: new Date(),
        },
        "dishcam"
      )
    ).toBe(false);
  });
});
