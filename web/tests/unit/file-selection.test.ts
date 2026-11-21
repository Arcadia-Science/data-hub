import { describe, expect, it } from "vitest";
import {
  buildFileRef,
  type FileRef,
  type PickedFile,
  refreshFileRefs,
} from "@/components/runs/file-selection-provider";
import type { RunFileRow } from "@/lib/api/instrument-runs";

// Only the columns the selection rules read.
function row(overrides: Partial<RunFileRow> & { id: number }): RunFileRow {
  return {
    category: "raw",
    deletedAt: null,
    filename: `file-${overrides.id}.tif`,
    s3Key: `dishcam/run/file-${overrides.id}.tif`,
    stalledProcessing: false,
    status: "detected",
    ...overrides,
  } as RunFileRow;
}

function refFor(file: RunFileRow): FileRef {
  return buildFileRef(file, "dishcam");
}

describe("buildFileRef", () => {
  it("lets a detected file be uploaded or deleted, not downloaded", () => {
    expect(refFor(row({ id: 1 })).caps).toEqual({
      upload: true,
      delete: true,
      reprocess: false,
      download: false,
      restore: false,
    });
  });

  it("lets a completed raw file be downloaded, reprocessed, and deleted", () => {
    expect(refFor(row({ id: 1, status: "completed" })).caps).toEqual({
      upload: false,
      delete: true,
      reprocess: true,
      download: true,
      restore: false,
    });
  });

  it("lets a deleted file be selected, for Restore and nothing else", () => {
    const ref = refFor(
      row({ id: 1, status: "completed", deletedAt: new Date() })
    );
    expect(ref.deleted).toBe(true);
    expect(ref.caps).toEqual({
      upload: false,
      delete: false,
      reprocess: false,
      download: false,
      restore: true,
    });
  });

  it("lets a file that is uploading be selected, for Delete alone", () => {
    const ref = refFor(row({ id: 2, status: "upload_requested", s3Key: null }));
    expect(ref.caps).toEqual({
      upload: false,
      delete: true,
      reprocess: false,
      download: false,
      restore: false,
    });
  });

  it("hides Delete for a file that is queued or processing, but not for a stalled one", () => {
    expect(refFor(row({ id: 1, status: "queued" })).caps.delete).toBe(false);
    expect(refFor(row({ id: 2, status: "processing" })).caps.delete).toBe(
      false
    );
    expect(
      refFor(row({ id: 3, status: "processing", stalledProcessing: true })).caps
        .delete
    ).toBe(true);
  });

  it("keeps the name and size a dialog lists, and the path its folder comes from", () => {
    const ref = refFor(
      row({
        id: 1,
        filename: "a.tif",
        relativePath: "plate/a.tif",
        sizeBytes: 2048,
      })
    );
    expect(ref).toMatchObject({
      filename: "a.tif",
      relativePath: "plate/a.tif",
      sizeBytes: 2048,
    });
  });
});

describe("refreshFileRefs", () => {
  function pick(file: RunFileRow, page = 1): PickedFile {
    return { page, ref: refFor(file) };
  }

  it("updates a visible file's actions when its status changes", () => {
    const picked = new Map([[1, pick(row({ id: 1 }))]]);
    const uploaded = row({ id: 1, status: "uploaded" });

    const next = refreshFileRefs(picked, [uploaded], "dishcam", 1);

    expect(next.get(1)?.ref.caps.upload).toBe(false);
    expect(next.get(1)?.ref.caps.download).toBe(true);
  });

  it("turns a selected file into a restorable one when it was deleted elsewhere", () => {
    const picked = new Map([[1, pick(row({ id: 1 }))]]);
    const deleted = row({ id: 1, deletedAt: new Date() });

    const next = refreshFileRefs(picked, [deleted], "dishcam", 1);

    expect(next.get(1)?.ref.deleted).toBe(true);
    expect(next.get(1)?.ref.caps.restore).toBe(true);
    expect(next.get(1)?.ref.caps.delete).toBe(false);
  });

  it("drops a file picked on this page whose row has left the results", () => {
    // Under a "Pending" filter, an uploaded file disappears from the list.
    const picked = new Map([[1, pick(row({ id: 1 }), 2)]]);

    expect(refreshFileRefs(picked, [row({ id: 5 })], "dishcam", 2).size).toBe(
      0
    );
  });

  it("keeps files picked on other pages as they were picked", () => {
    const offPage = pick(row({ id: 9 }), 3);
    const picked = new Map([[9, offPage]]);

    const next = refreshFileRefs(picked, [row({ id: 1 })], "dishcam", 1);

    expect(next.get(9)).toBe(offPage);
  });

  it("moves a file that shows up on this page to this page", () => {
    const picked = new Map([[4, pick(row({ id: 4 }), 3)]]);

    const next = refreshFileRefs(picked, [row({ id: 4 })], "dishcam", 1);

    expect(next.get(4)?.page).toBe(1);
  });

  it("does not change the picked map it is given", () => {
    const picked = new Map([[1, pick(row({ id: 1 }))]]);
    refreshFileRefs(picked, [row({ id: 1, status: "uploaded" })], "dishcam", 1);
    expect(picked.get(1)?.ref.caps.upload).toBe(true);
  });
});
