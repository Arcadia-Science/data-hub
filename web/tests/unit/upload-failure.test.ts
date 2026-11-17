import { describe, expect, it } from "vitest";
import {
  folderOf,
  groupUploadFailures,
  uploadFailedNotificationText,
  uploadFailureMessage,
} from "@/lib/runs/upload-failure";

const row = (
  id: number,
  relativePath: string,
  reason: "folder_missing" | "file_missing" | "upload_error" | "unsafe_path",
  errorMessage: string | null,
  uploadFailedAt = new Date("2026-11-16T10:00:00Z")
) => ({
  errorMessage,
  id,
  relativePath,
  uploadFailedAt,
  uploadFailureReason: reason,
});

describe("folderOf", () => {
  it("is the folder part of a relative path", () => {
    expect(folderOf("a/b/c.nd2")).toBe("a/b");
    expect(folderOf("c.nd2")).toBe(null);
    expect(folderOf(null)).toBe(null);
  });
});

describe("uploadFailedNotificationText", () => {
  it("counts the files and gives the reason", () => {
    expect(uploadFailedNotificationText(129, "folder_missing")).toBe(
      "129 files couldn't upload: folder no longer on the instrument PC."
    );
    expect(uploadFailedNotificationText(1, "upload_error")).toBe(
      "1 file couldn't upload: the upload kept failing."
    );
  });
});

describe("groupUploadFailures", () => {
  it("puts a renamed run folder's files in one block, with its message", () => {
    const message = uploadFailureMessage("folder_missing", "run-1", null);
    const groups = groupUploadFailures([
      row(1, "run-1/a.nd2", "folder_missing", message),
      row(2, "run-1/b.nd2", "folder_missing", message),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      fileIds: [1, 2],
      folder: "run-1",
      message:
        "The folder run-1 is no longer on the instrument PC. It may have been renamed or moved.",
      reason: "folder_missing",
    });
  });

  it("splits by reason and folder, largest block first", () => {
    const groups = groupUploadFailures([
      row(1, "run-1/a.nd2", "upload_error", "x"),
      row(2, "run-1/b.nd2", "folder_missing", "y"),
      row(3, "run-1/c.nd2", "folder_missing", "y"),
      row(4, "run-2/d.nd2", "folder_missing", "z"),
    ]);
    expect(groups.map((g) => [g.reason, g.folder, g.fileIds])).toEqual([
      ["folder_missing", "run-1", [2, 3]],
      ["upload_error", "run-1", [1]],
      ["folder_missing", "run-2", [4]],
    ]);
  });

  it("uses the general message when the files' messages differ", () => {
    const [group] = groupUploadFailures([
      row(
        1,
        "run-1/a.nd2",
        "upload_error",
        "The watcher couldn't upload the file: timeout"
      ),
      row(
        2,
        "run-1/b.nd2",
        "upload_error",
        "The watcher couldn't upload the file: reset"
      ),
    ]);
    expect(group.message).toBe("The watcher couldn't upload the file.");
  });

  it("keeps the latest failure time", () => {
    const [group] = groupUploadFailures([
      row(1, "a.nd2", "file_missing", "m", new Date("2026-11-16T10:00:00Z")),
      row(2, "b.nd2", "file_missing", "m", new Date("2026-11-16T12:00:00Z")),
    ]);
    expect(group.lastFailedAt).toEqual(new Date("2026-11-16T12:00:00Z"));
  });
});
