import { describe, expect, it } from "vitest";
import {
  fileStem,
  isCsvFile,
  isImageFile,
  isPdfFile,
  isVideoFile,
} from "@/lib/runs/run-file-types";

describe("isVideoFile", () => {
  it("matches video content types", () => {
    expect(
      isVideoFile({ filename: "clip.bin", contentType: "video/mp4" })
    ).toBe(true);
  });

  it("matches .mp4 filenames", () => {
    expect(isVideoFile({ filename: "stack.MP4", contentType: null })).toBe(
      true
    );
  });

  it("does not match images or csv", () => {
    expect(
      isVideoFile({ filename: "stack.jpg", contentType: "image/jpeg" })
    ).toBe(false);
    expect(isCsvFile({ filename: "data.csv", contentType: "text/csv" })).toBe(
      true
    );
    expect(
      isImageFile({ filename: "stack.jpg", contentType: "image/jpeg" })
    ).toBe(true);
    expect(
      isPdfFile({ filename: "report.pdf", contentType: "application/pdf" })
    ).toBe(true);
  });
});

describe("fileStem", () => {
  it("strips the last extension", () => {
    expect(fileStem("stack.mp4")).toBe("stack");
    expect(fileStem("stack")).toBe("stack");
  });
});
