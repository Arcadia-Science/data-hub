import { describe, expect, it } from "vitest";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import { previewFilesOf } from "@/lib/runs/preview-files";

function row(
  overrides: Partial<RunFileRow> & { id: number; filename: string }
): RunFileRow {
  return {
    category: "raw",
    contentType: null,
    status: "completed",
    ...overrides,
  } as RunFileRow;
}

describe("previewFilesOf", () => {
  it("makes an entry for every file, in the order given", () => {
    const entries = previewFilesOf([
      row({ id: 3, filename: "capture.tif" }),
      row({ id: 1, filename: "results.csv", category: "processed" }),
      row({ id: 2, filename: "preview.mp4", category: "processed" }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual([3, 1, 2]);
    expect(entries.map((entry) => entry.filename)).toEqual([
      "capture.tif",
      "results.csv",
      "preview.mp4",
    ]);
  });

  it("shows the contents of text files and leaves the other formats without a kind", () => {
    const [csv, tif, mp4] = previewFilesOf([
      row({ id: 1, filename: "results.csv" }),
      row({ id: 2, filename: "capture.tif" }),
      row({ id: 3, filename: "preview.mp4" }),
    ]);
    expect(csv.kind).toBe("csv");
    expect(tif.kind).toBeNull();
    expect(mp4.kind).toBeNull();
  });

  it("can download a file in storage, whatever its status", () => {
    const entries = previewFilesOf(
      (
        ["uploaded", "queued", "processing", "completed", "failed"] as const
      ).map((status, i) => row({ id: i, filename: `f${i}.tif`, status }))
    );
    expect(entries.every((entry) => entry.downloadable)).toBe(true);
  });

  it("can neither download nor read a file that is still on the instrument PC", () => {
    const entries = previewFilesOf(
      (["detected", "upload_requested", "upload_failed"] as const).map(
        (status, i) => row({ id: i, filename: `notes${i}.csv`, status })
      )
    );
    expect(entries.every((entry) => !entry.downloadable)).toBe(true);
    expect(entries.every((entry) => entry.kind === null)).toBe(true);
  });

  it("keeps a deleted file that reached storage downloadable", () => {
    const [entry] = previewFilesOf([
      row({
        id: 1,
        filename: "results.csv",
        deletedAt: new Date("2026-11-20T10:00:00Z"),
      }),
    ]);
    expect(entry.downloadable).toBe(true);
    expect(entry.kind).toBe("csv");
  });
});

describe("previewFilesOf media", () => {
  it("shows images, MP4 video, and PDFs as they are", () => {
    const [jpg, png, webp, gif, mp4, pdf] = previewFilesOf([
      row({ id: 1, filename: "a.jpg" }),
      row({ id: 2, filename: "b.PNG" }),
      row({ id: 3, filename: "c.webp" }),
      row({ id: 4, filename: "d.gif" }),
      row({ id: 5, filename: "e.mp4" }),
      row({ id: 6, filename: "f.pdf" }),
    ]);
    expect([jpg, png, webp, gif].map((entry) => entry.media)).toEqual([
      "image",
      "image",
      "image",
      "image",
    ]);
    expect(mp4.media).toBe("video");
    expect(pdf.media).toBe("pdf");
    // They load themselves, not as text.
    expect([jpg, mp4, pdf].map((entry) => entry.kind)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("leaves a TIFF without a way to show it", () => {
    const [tif] = previewFilesOf([
      row({ id: 1, filename: "capture.tif", contentType: "image/tiff" }),
    ]);
    expect(tif.media).toBeNull();
    expect(tif.kind).toBeNull();
  });

  it("shows nothing for a file still on the instrument PC", () => {
    const [entry] = previewFilesOf([
      row({ id: 1, filename: "a.jpg", status: "detected" }),
    ]);
    expect(entry.media).toBeNull();
  });

  it("keeps a deleted picture viewable", () => {
    const [entry] = previewFilesOf([
      row({ id: 1, filename: "a.jpg", deletedAt: new Date() }),
    ]);
    expect(entry.media).toBe("image");
  });

  it("carries the row so the window can list its details", () => {
    const source = row({ id: 1, filename: "a.jpg" });
    expect(previewFilesOf([source])[0].row).toBe(source);
  });
});
