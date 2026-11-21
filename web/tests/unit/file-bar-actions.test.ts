import { describe, expect, it } from "vitest";
import { canDeleteFile } from "@/lib/runs/deletable-files";
import {
  type FileCaps,
  fileBarState,
  selectAllTargets,
} from "@/lib/runs/file-bar-actions";

const none: FileCaps = {
  upload: false,
  download: false,
  reprocess: false,
  delete: false,
  restore: false,
};

function ref(caps: Partial<FileCaps>, deleted = false) {
  return { caps: { ...none, ...caps }, deleted };
}

const pending = ref({ upload: true, delete: true });
const uploaded = ref({ download: true, reprocess: true, delete: true });
const deleted = ref({ restore: true }, true);

describe("fileBarState", () => {
  it("offers Upload, Download, Reprocess, and Delete in that order", () => {
    const everything = ref({
      upload: true,
      download: true,
      reprocess: true,
      delete: true,
    });
    expect(fileBarState([everything]).actions).toEqual([
      "upload",
      "download",
      "reprocess",
      "delete",
    ]);
  });

  it("offers an action only when every selected file supports it", () => {
    expect(fileBarState([uploaded, uploaded]).actions).toEqual([
      "download",
      "reprocess",
      "delete",
    ]);
    // Pending and uploaded files share only Delete.
    expect(fileBarState([pending, uploaded]).actions).toEqual(["delete"]);
  });

  it("offers Restore alone for deleted files, and calls them deleted files", () => {
    expect(fileBarState([deleted, deleted])).toEqual({
      actions: ["restore"],
      noun: "deleted file",
    });
  });

  it("offers nothing when active and deleted files are mixed", () => {
    expect(fileBarState([uploaded, deleted])).toEqual({
      actions: [],
      noun: "file",
    });
  });

  it("leaves out Delete when a selected file can't be deleted", () => {
    const processing = ref({ download: true });
    expect(fileBarState([uploaded, processing]).actions).toEqual(["download"]);
  });

  it("offers nothing for an empty selection", () => {
    expect(fileBarState([])).toEqual({ actions: [], noun: "file" });
  });
});

describe("selectAllTargets", () => {
  it("picks the active rows when the page has any", () => {
    const rows = [
      { id: 1, deleted: false },
      { id: 2, deleted: true },
      { id: 3, deleted: false },
    ];
    expect(selectAllTargets(rows).map((row) => row.id)).toEqual([1, 3]);
  });

  it("picks the deleted rows when the page has only those", () => {
    const rows = [
      { id: 2, deleted: true },
      { id: 4, deleted: true },
    ];
    expect(selectAllTargets(rows).map((row) => row.id)).toEqual([2, 4]);
  });
});

describe("canDeleteFile", () => {
  function file(
    status: Parameters<typeof canDeleteFile>[0]["status"],
    overrides: Partial<Parameters<typeof canDeleteFile>[0]> = {}
  ) {
    return { deletedAt: null, status, stalledProcessing: false, ...overrides };
  }

  it.each([
    "detected",
    "upload_requested",
    "upload_failed",
    "uploaded",
    "completed",
    "failed",
  ] as const)("allows a %s file", (status) => {
    expect(canDeleteFile(file(status))).toBe(true);
  });

  it("refuses a queued file and one that is processing", () => {
    expect(canDeleteFile(file("queued"))).toBe(false);
    expect(canDeleteFile(file("processing"))).toBe(false);
  });

  it("allows a processing file once it has stalled", () => {
    expect(canDeleteFile(file("processing", { stalledProcessing: true }))).toBe(
      true
    );
  });

  it("refuses a file that is already deleted", () => {
    expect(canDeleteFile(file("completed", { deletedAt: new Date() }))).toBe(
      false
    );
  });
});
