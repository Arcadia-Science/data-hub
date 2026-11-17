import type { files } from "@/lib/db/schema";

// Why the watcher gave up on a file, and how each reason reads. Shared by the
// server (the file's `error_message` and the Event Log entry) and the web app,
// so a reason reads the same everywhere. Client-safe: the schema import is
// type-only.

export type UploadFailureReason = NonNullable<
  (typeof files.$inferSelect)["uploadFailureReason"]
>;

// The folder a file sits in, relative to the watch folder. Null for a file at
// the top of the watch folder.
export function folderOf(relativePath: string | null): string | null {
  if (!relativePath) {
    return null;
  }
  const slash = relativePath.lastIndexOf("/");
  return slash > 0 ? relativePath.slice(0, slash) : null;
}

// A short phrase for summaries: "Couldn't upload 12 files: <phrase>".
export const UPLOAD_FAILURE_SUMMARY: Record<UploadFailureReason, string> = {
  folder_missing: "folder no longer on the instrument PC",
  file_missing: "files not on the instrument PC",
  upload_error: "the upload kept failing",
  unsafe_path: "path outside the watch folder",
};

// The notification text for files of one run that failed for one reason:
// "129 files couldn't upload: folder no longer on the instrument PC."
export function uploadFailedNotificationText(
  failedCount: number,
  reason: UploadFailureReason
): string {
  const files = failedCount === 1 ? "1 file" : `${failedCount} files`;
  return `${files} couldn't upload: ${UPLOAD_FAILURE_SUMMARY[reason]}.`;
}

// Files of one run that failed for the same reason in the same folder, as the
// run page's banner shows them: one block each.
export interface UploadFailureGroup {
  fileIds: number[];
  folder: string | null;
  // The latest time the watcher gave up on one of them.
  lastFailedAt: Date | null;
  // The reason, as one sentence for the whole group.
  message: string;
  reason: UploadFailureReason;
}

// Groups a run's `upload_failed` files by reason and folder, largest group
// first. A group whose files all carry the same message shows it (for
// `upload_error` that includes the last error); otherwise the group gets the
// reason's general message.
export function groupUploadFailures(
  rows: readonly {
    errorMessage: string | null;
    id: number;
    relativePath: string | null;
    uploadFailedAt: Date | null;
    uploadFailureReason: UploadFailureReason | null;
  }[]
): UploadFailureGroup[] {
  const groups = new Map<
    string,
    UploadFailureGroup & { messages: Set<string | null> }
  >();
  for (const row of rows) {
    if (!row.uploadFailureReason) {
      continue;
    }
    const folder = folderOf(row.relativePath);
    const key = `${row.uploadFailureReason}\u0000${folder ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        fileIds: [],
        folder,
        lastFailedAt: null,
        message: "",
        messages: new Set(),
        reason: row.uploadFailureReason,
      };
      groups.set(key, group);
    }
    group.fileIds.push(row.id);
    group.messages.add(row.errorMessage);
    if (
      row.uploadFailedAt &&
      (!group.lastFailedAt || row.uploadFailedAt > group.lastFailedAt)
    ) {
      group.lastFailedAt = row.uploadFailedAt;
    }
  }
  return [...groups.values()]
    .map(({ messages, ...group }) => {
      const [only] = messages;
      return {
        ...group,
        message:
          messages.size === 1 && only
            ? only
            : uploadFailureMessage(group.reason, group.folder, null),
      };
    })
    .sort((a, b) => b.fileIds.length - a.fileIds.length);
}

// The full explanation for one file, stored in its `error_message`. `folder`
// is the file's folder (see `folderOf`), and `detail` is the watcher's last
// error for `upload_error`.
export function uploadFailureMessage(
  reason: UploadFailureReason,
  folder: string | null,
  detail: string | null
): string {
  switch (reason) {
    case "folder_missing":
      return folder
        ? `The folder ${folder} is no longer on the instrument PC. It may have been renamed or moved.`
        : "The file's folder is no longer on the instrument PC. It may have been renamed or moved.";
    case "file_missing":
      return folder
        ? `The file isn't in ${folder} on the instrument PC.`
        : "The file isn't in the watch folder on the instrument PC.";
    case "upload_error":
      return detail
        ? `The watcher couldn't upload the file: ${detail}`
        : "The watcher couldn't upload the file.";
    case "unsafe_path":
      return "The file's path points outside the watch folder, so the watcher won't upload it.";
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}
