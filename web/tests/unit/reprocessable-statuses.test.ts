import { describe, expect, it } from "vitest";
import { canReprocessFile } from "@/lib/runs/reprocessable-statuses";

const rawCompleted = {
  category: "raw",
  deletedAt: null,
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
});
