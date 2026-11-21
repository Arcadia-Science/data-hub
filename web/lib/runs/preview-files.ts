import type { RunFileRow } from "@/lib/api/instrument-runs";
import { IN_S3_FILE_STATUSES } from "@/lib/runs/file-buckets";
import {
  type FilePreviewKind,
  filePreviewKind,
} from "@/lib/runs/run-file-types";

/** One file of the run page's files table, as the file window shows it. */
export interface PreviewFile {
  category: string;
  // Whether the file has reached Data Hub storage, so it can be downloaded.
  downloadable: boolean;
  filename: string;
  id: number;
  // How to show the file's contents, or null when the window can't show them.
  kind: FilePreviewKind | null;
}

/**
 * Every file on the page becomes an entry, in the order given, so the window's
 * previous and next buttons step through the table row by row. Only a file in
 * storage can be previewed or downloaded, so a file still on the instrument PC
 * gets no kind, even when its name says CSV.
 */
export function previewFilesOf(
  files: readonly Pick<
    RunFileRow,
    "category" | "contentType" | "filename" | "id" | "status"
  >[]
): PreviewFile[] {
  return files.map((file) => {
    const downloadable = IN_S3_FILE_STATUSES.includes(file.status);
    return {
      category: file.category,
      downloadable,
      filename: file.filename,
      id: file.id,
      kind: downloadable ? filePreviewKind(file) : null,
    };
  });
}
