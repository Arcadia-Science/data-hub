import { describe, expect, it } from "vitest";
import {
  filePreviewKind,
  fileStem,
  isCsvFile,
  isImageFile,
  isPdfFile,
  isPreviewableFile,
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

describe("filePreviewKind", () => {
  it.each([
    ["data.csv", "csv"],
    ["DATA.CSV", "csv"],
    ["data.tsv", "tsv"],
    ["meta.json", "json"],
    ["notes.txt", "text"],
    ["run.log", "text"],
    ["config.yaml", "text"],
    ["config.YML", "text"],
    ["README.md", "text"],
  ])("detects %s by extension", (filename, kind) => {
    expect(filePreviewKind({ filename, contentType: null })).toBe(kind);
  });

  it("trusts the extension over binary/octet-stream", () => {
    expect(
      filePreviewKind({ filename: "a.csv", contentType: "binary/octet-stream" })
    ).toBe("csv");
  });

  it("falls back to the content type", () => {
    expect(filePreviewKind({ filename: "a", contentType: "text/csv" })).toBe(
      "csv"
    );
    expect(
      filePreviewKind({
        filename: "a",
        contentType: "text/tab-separated-values",
      })
    ).toBe("tsv");
    expect(
      filePreviewKind({ filename: "a", contentType: "application/json" })
    ).toBe("json");
    expect(filePreviewKind({ filename: "a", contentType: "text/plain" })).toBe(
      "text"
    );
    expect(
      filePreviewKind({ filename: "a.dat", contentType: "text/x-foo" })
    ).toBe("text");
  });

  it("excludes HTML", () => {
    expect(filePreviewKind({ filename: "a", contentType: "text/html" })).toBe(
      null
    );
    expect(
      filePreviewKind({ filename: "a.html", contentType: "text/plain" })
    ).toBe(null);
    expect(filePreviewKind({ filename: "a.HTM", contentType: null })).toBe(
      null
    );
    expect(
      filePreviewKind({
        filename: "a",
        contentType: "text/html; charset=utf-8",
      })
    ).toBe(null);
  });

  it("ignores content type parameters", () => {
    expect(
      filePreviewKind({ filename: "a", contentType: "text/csv; charset=utf-8" })
    ).toBe("csv");
    expect(
      filePreviewKind({
        filename: "a",
        contentType: "Application/JSON; charset=utf-8",
      })
    ).toBe("json");
  });

  it("excludes images, PDFs, and binary types", () => {
    for (const file of [
      { filename: "a.png", contentType: "image/png" },
      { filename: "a.pdf", contentType: "application/pdf" },
      { filename: "a.nd2", contentType: "application/octet-stream" },
      { filename: "a.mp4", contentType: null },
    ]) {
      expect(isPreviewableFile(file)).toBe(false);
    }
  });

  it("reports previewable files", () => {
    expect(isPreviewableFile({ filename: "a.json", contentType: null })).toBe(
      true
    );
  });
});
