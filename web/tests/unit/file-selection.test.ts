import { describe, expect, it } from "vitest";
import {
  buildFileRef,
  type FileRef,
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
  const ref = buildFileRef(file, "dishcam");
  if (ref === null) {
    throw new Error("expected a selectable file");
  }
  return ref;
}

describe("buildFileRef", () => {
  it("lets a detected file be uploaded or dismissed, not downloaded", () => {
    expect(refFor(row({ id: 1 })).caps).toEqual({
      upload: true,
      dismiss: true,
      reprocess: false,
      download: false,
    });
  });

  it("lets a completed raw file be downloaded and reprocessed", () => {
    expect(refFor(row({ id: 1, status: "completed" })).caps).toEqual({
      upload: false,
      dismiss: false,
      reprocess: true,
      download: true,
    });
  });

  it("skips dismissed files and transient upload requests", () => {
    expect(buildFileRef(row({ id: 1, deletedAt: new Date() }), "dishcam")).toBe(
      null
    );
    expect(
      buildFileRef(row({ id: 2, status: "upload_requested" }), "dishcam")
    ).toBe(null);
  });
});

describe("refreshFileRefs", () => {
  it("updates a visible file's actions when its status changes", () => {
    const detected = row({ id: 1 });
    const picked = new Map([[1, refFor(detected)]]);
    const uploaded = row({ id: 1, status: "uploaded" });

    const next = refreshFileRefs(picked, [uploaded], "dishcam");

    expect(next.get(1)?.caps.upload).toBe(false);
    expect(next.get(1)?.caps.download).toBe(true);
  });

  it("drops a visible file that can no longer be selected", () => {
    const picked = new Map([[1, refFor(row({ id: 1 }))]]);
    const dismissed = row({ id: 1, deletedAt: new Date() });

    expect(refreshFileRefs(picked, [dismissed], "dishcam").size).toBe(0);
  });

  it("keeps files from other pages as they were picked", () => {
    const offPage = refFor(row({ id: 9 }));
    const picked = new Map([[9, offPage]]);

    const next = refreshFileRefs(picked, [row({ id: 1 })], "dishcam");

    expect(next.get(9)).toBe(offPage);
  });

  it("does not change the picked map it is given", () => {
    const picked = new Map([[1, refFor(row({ id: 1 }))]]);
    refreshFileRefs(picked, [row({ id: 1, status: "uploaded" })], "dishcam");
    expect(picked.get(1)?.caps.upload).toBe(true);
  });
});
