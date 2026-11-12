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
  overrides: { deletedAt?: Date | null; stalledProcessing?: boolean } = {}
): FileStatusDisplayKey {
  return getFileStatusKey({
    deletedAt: null,
    stalledProcessing: false,
    status,
    ...overrides,
  });
}

describe("getFileStatusKey", () => {
  it("gives every file status its own display key", () => {
    const expected: Record<FileStatus, FileStatusDisplayKey> = {
      detected: "pending",
      upload_requested: "uploading",
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

  it("lets a stalled processing file read as stalled", () => {
    expect(key("processing", { stalledProcessing: true })).toBe("stalled");
  });

  it("reads a dismissed file as dismissed whatever its status", () => {
    expect(key("queued", { deletedAt: new Date() })).toBe("dismissed");
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
