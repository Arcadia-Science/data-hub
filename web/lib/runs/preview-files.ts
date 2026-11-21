import type { RunFileRow } from "@/lib/api/instrument-runs";
import { IN_S3_FILE_STATUSES } from "@/lib/runs/file-buckets";
import {
  type FilePreviewKind,
  type FilePreviewMedia,
  filePreviewKind,
  filePreviewMedia,
} from "@/lib/runs/run-file-types";

/** One file of the run page, as the file window shows it. */
export interface PreviewFile {
  category: string;
  // Whether the file has reached Data Hub storage, so it can be downloaded.
  downloadable: boolean;
  filename: string;
  id: number;
  // How to read the file's contents as text, or null when it is not text.
  kind: FilePreviewKind | null;
  // How to show the file when it is a picture, a video, or a PDF, or null.
  media: FilePreviewMedia | null;
  // The whole row, for the details the window lists.
  row: RunFileRow;
}

/**
 * Every file given becomes an entry, in the order given, so the window's
 * previous and next buttons step through the table row by row. Only a file in
 * storage can be previewed or downloaded, so a file still on the instrument PC
 * gets neither a kind nor a media type, even when its name says CSV. A deleted
 * file that reached storage keeps both: it stays readable by its ID.
 */
export function previewFilesOf(files: readonly RunFileRow[]): PreviewFile[] {
  return files.map((file) => {
    const downloadable = IN_S3_FILE_STATUSES.includes(file.status);
    return {
      category: file.category,
      downloadable,
      filename: file.filename,
      id: file.id,
      kind: downloadable ? filePreviewKind(file) : null,
      media: downloadable ? filePreviewMedia(file) : null,
      row: file,
    };
  });
}
