import { describe, expect, it } from "vitest";
import {
  FILE_STATUS_CONFIG,
  FILE_STATUS_LEGEND_SECTIONS,
  type FileStatusDisplayKey,
  getFileStatusKey,
} from "@/components/runs/file-status-config";
import { fileStatusEnum } from "@/lib/db/schema";

type FileStatus = (typeof fileStatusEnum.enumValues)[number];

function key(
  status: FileStatus,
  overrides: {
    autoUploadExpectedAt?: Date | null;
    deletedAt?: Date | null;
    stalledProcessing?: boolean;
  } = {}
): FileStatusDisplayKey {
  return getFileStatusKey({
    autoUploadExpectedAt: null,
    deletedAt: null,
    stalledProcessing: false,
    status,
    ...overrides,
  });
}

describe("getFileStatusKey", () => {
  it("gives every file status its own display key", () => {
    const expected: Record<FileStatus, FileStatusDisplayKey> = {
      detected: "not_uploaded",
      upload_requested: "uploading",
      upload_failed: "upload_failed",
      uploaded: "uploaded",
      queued: "queued",
      processing: "processing",
      completed: "completed",
      failed: "failed",
    };
    // Typed as a Record over the enum, so a status added to the database
    // without a row here fails to compile.
    for (const status of fileStatusEnum.enumValues) {
      expect(key(status)).toBe(expected[status]);
    }
  });

  // A `queued` file used to be able to fall through to "pending", which reads
  // as "not yet uploaded" when the file is in S3 and waiting for a slot.
  it("labels a queued file Queued, not Pending", () => {
    expect(key("queued")).toBe("queued");
    expect(FILE_STATUS_CONFIG[key("queued")].label).toBe("Queued");
  });

  it("labels a detected file Not uploaded unless the watcher will upload it", () => {
    expect(FILE_STATUS_CONFIG[key("detected")].label).toBe("Not uploaded");
    expect(
      FILE_STATUS_CONFIG[key("detected", { autoUploadExpectedAt: new Date() })]
        .label
    ).toBe("Waiting to upload");
  });

  it("labels a file the watcher gave up on Upload failed", () => {
    expect(FILE_STATUS_CONFIG[key("upload_failed")].label).toBe(
      "Upload failed"
    );
  });

  it("lets a stalled processing file read as stalled", () => {
    expect(key("processing", { stalledProcessing: true })).toBe("stalled");
  });

  it("reads a deleted file as deleted whatever its status", () => {
    expect(key("queued", { deletedAt: new Date() })).toBe("deleted");
    expect(FILE_STATUS_CONFIG.deleted.label).toBe("Deleted");
  });
});

describe("FILE_STATUS_LEGEND_SECTIONS", () => {
  it("lists Queued under Waiting", () => {
    const waiting = FILE_STATUS_LEGEND_SECTIONS.find(
      (s) => s.key === "waiting"
    );
    expect(waiting?.statuses).toContain("queued");
  });

  it("lists every display key exactly once", () => {
    const listed = FILE_STATUS_LEGEND_SECTIONS.flatMap((s) => s.statuses);
    expect([...listed].sort()).toEqual(Object.keys(FILE_STATUS_CONFIG).sort());
  });
});
