import { describe, expect, it } from "vitest";
import {
  contentDispositionHeader,
  contentTypeForDownload,
  localMirrorDownloadUrl,
  mimeFor,
  parseByteRange,
} from "@/lib/s3-local-mirror";

describe("parseByteRange", () => {
  it("serves the full file when Range is missing or malformed", () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: "full" });
    expect(parseByteRange("bytes=", 100)).toEqual({ kind: "full" });
    expect(parseByteRange("wibble", 100)).toEqual({ kind: "full" });
  });

  it("parses open-ended and closed ranges", () => {
    expect(parseByteRange("bytes=0-1", 100)).toEqual({
      kind: "partial",
      start: 0,
      end: 1,
    });
    expect(parseByteRange("bytes=50-", 100)).toEqual({
      kind: "partial",
      start: 50,
      end: 99,
    });
    expect(parseByteRange("bytes=-10", 100)).toEqual({
      kind: "partial",
      start: 90,
      end: 99,
    });
  });

  it("rejects ranges past the end of the file", () => {
    expect(parseByteRange("bytes=100-101", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseByteRange("bytes=0-1", 0)).toEqual({
      kind: "unsatisfiable",
    });
  });
});

describe("mimeFor", () => {
  it("maps mp4 to video/mp4 so the local player can seek", () => {
    expect(mimeFor("/tmp/stack.mp4")).toBe("video/mp4");
  });

  it("treats uppercase PDF extensions as application/pdf", () => {
    expect(mimeFor("Experiment_Report.PDF")).toBe("application/pdf");
  });
});

describe("contentTypeForDownload", () => {
  it("keeps a specific stored type", () => {
    expect(contentTypeForDownload("application/pdf", "report.PDF")).toBe(
      "application/pdf"
    );
  });

  it("replaces a generic binary type using the filename", () => {
    expect(contentTypeForDownload("binary/octet-stream", "report.PDF")).toBe(
      "application/pdf"
    );
    expect(contentTypeForDownload("application/octet-stream", "data.csv")).toBe(
      "text/csv"
    );
  });

  it("infers from the filename when nothing is stored", () => {
    expect(contentTypeForDownload(null, "report.PDF")).toBe("application/pdf");
  });

  it("returns undefined for unknown extensions", () => {
    expect(contentTypeForDownload(null, "notes.xyz")).toBeUndefined();
  });
});

describe("contentDispositionHeader", () => {
  it("keeps a bare filename as attachment", () => {
    expect(contentDispositionHeader(undefined, "run.zip")).toBe(
      'attachment; filename="run.zip"'
    );
  });

  it("signs report embeds as inline", () => {
    expect(contentDispositionHeader("inline", "report.PDF")).toBe(
      'inline; filename="report.PDF"'
    );
  });
});

describe("localMirrorDownloadUrl", () => {
  it("omits disposition when neither option is set", () => {
    expect(localMirrorDownloadUrl("raw", "run/file.pdf")).toBe(
      "/api/local-s3/raw/run/file.pdf"
    );
  });

  it("passes an inline header for report embeds", () => {
    expect(
      localMirrorDownloadUrl("raw", "run/file.pdf", {
        disposition: "inline",
        filename: "file.pdf",
      })
    ).toBe(
      "/api/local-s3/raw/run/file.pdf?disposition=inline%3B%20filename%3D%22file.pdf%22"
    );
  });
});
