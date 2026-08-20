import { describe, expect, it } from "vitest";
import {
  fileStem,
  isCsvFile,
  isImageFile,
  isPdfFile,
  isVideoFile,
  posterFileIdsByVideoFilename,
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
    expect(fileStem("foo.bar.mp4")).toBe("foo.bar");
    expect(fileStem("foo.bar.jpg")).toBe("foo.bar");
  });
});

describe("posterFileIdsByVideoFilename", () => {
  const processed = {
    category: "processed" as const,
    deletedAt: null,
  };

  it("maps a video to a same-stem processed jpeg", () => {
    expect(
      posterFileIdsByVideoFilename([
        {
          ...processed,
          contentType: "video/mp4",
          filename: "stack.mp4",
          id: 1,
        },
        {
          ...processed,
          contentType: "image/jpeg",
          filename: "stack.jpg",
          id: 2,
        },
      ])
    ).toEqual({ "stack.mp4": 2 });
  });

  it("pairs dotted stems by last extension only", () => {
    expect(
      posterFileIdsByVideoFilename([
        {
          ...processed,
          contentType: "video/mp4",
          filename: "foo.bar.mp4",
          id: 1,
        },
        {
          ...processed,
          contentType: "image/jpeg",
          filename: "foo.bar.jpg",
          id: 2,
        },
      ])
    ).toEqual({ "foo.bar.mp4": 2 });
  });

  it("omits videos with no poster and ignores raw or deleted files", () => {
    expect(
      posterFileIdsByVideoFilename([
        {
          ...processed,
          contentType: "video/mp4",
          filename: "lonely.mp4",
          id: 1,
        },
        {
          category: "raw",
          contentType: "image/jpeg",
          deletedAt: null,
          filename: "lonely.jpg",
          id: 2,
        },
        {
          category: "processed",
          contentType: "image/jpeg",
          deletedAt: new Date("2026-01-01"),
          filename: "gone.jpg",
          id: 3,
        },
        {
          ...processed,
          contentType: "video/mp4",
          filename: "gone.mp4",
          id: 4,
        },
      ])
    ).toEqual({});
  });
});
