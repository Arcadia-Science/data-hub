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
