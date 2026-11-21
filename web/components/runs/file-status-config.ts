import type { LucideIcon } from "lucide-react";
import {
  CircleAlert,
  CircleCheck,
  Clock,
  Cloud,
  CloudAlert,
  CloudUpload,
  HardDrive,
  Hourglass,
  LoaderCircle,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type { RunFileRow } from "@/lib/api/instrument-runs";

// The gray of a deleted file's text, #6b6b6b in light mode: 5.3 to 1 against a
// white row and 5.0 to 1 against a selected one. Fading the whole row to half
// opacity, as deleted rows used to be, dropped the text to about 3.7 to 1. The
// dark theme's muted text is 5.9 to 1 against its row.
export const DELETED_TEXT_CLASS = "text-[#6b6b6b] dark:text-muted-foreground";

// The gray type badge of a deleted file: #5c5c5c on #f0f0f0 is 5.9 to 1.
export const DELETED_BADGE_CLASS =
  "bg-[#f0f0f0] text-[#5c5c5c] dark:bg-muted dark:text-muted-foreground";

export type FileStatusDisplayKey =
  | "not_uploaded"
  | "waiting_upload"
  | "upload_failed"
  | "uploading"
  | "uploaded"
  | "queued"
  | "processing"
  | "stalled"
  | "completed"
  | "failed"
  | "deleted";

export type FileStatusLegendSectionKey =
  | "waiting"
  | "in_motion"
  | "done"
  | "removed";

interface FileStatusConfigEntry {
  className: string;
  description: string;
  Icon: LucideIcon;
  label: string;
  spin?: boolean;
}

// `stalledProcessing` is required, not optional: a plain `files` row would
// otherwise compile here and silently label a stalled file "Processing".
// `autoUploadExpectedAt` is required for the same reason: without it a file
// the watcher is about to upload would read "Not uploaded".
export function getFileStatusKey(
  file: Pick<
    RunFileRow,
    "autoUploadExpectedAt" | "deletedAt" | "stalledProcessing" | "status"
  >
): FileStatusDisplayKey {
  if (file.deletedAt !== null) {
    return "deleted";
  }
  if (file.stalledProcessing) {
    return "stalled";
  }
  switch (file.status) {
    case "detected":
      return file.autoUploadExpectedAt === null
        ? "not_uploaded"
        : "waiting_upload";
    case "upload_requested":
      return "uploading";
    case "upload_failed":
      return "upload_failed";
    case "uploaded":
      return "uploaded";
    case "queued":
      return "queued";
    case "processing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default: {
      // A new file status without a case here would otherwise read as
      // "Not uploaded" and hide where the file really is.
      const unhandled: never = file.status;
      return unhandled;
    }
  }
}

export const FILE_STATUS_CONFIG: Record<
  FileStatusDisplayKey,
  FileStatusConfigEntry
> = {
  not_uploaded: {
    label: "Not uploaded",
    description: "only on the instrument PC, request to upload",
    Icon: HardDrive,
    className: "text-muted-foreground",
  },
  waiting_upload: {
    label: "Waiting to upload",
    description: "the watcher uploads it on its own",
    Icon: Clock,
    className: "text-muted-foreground",
  },
  upload_failed: {
    label: "Upload failed",
    description: "the watcher gave up, can request again",
    Icon: CloudAlert,
    className: "text-destructive",
  },
  uploaded: {
    label: "Uploaded",
    description: "stored, awaiting processing",
    Icon: Cloud,
    className: "text-muted-foreground",
  },
  queued: {
    label: "Queued",
    description: "waiting for a free processing slot",
    Icon: Hourglass,
    className: "text-muted-foreground",
  },
  uploading: {
    label: "Uploading",
    description: "transfer in progress",
    Icon: CloudUpload,
    className: "text-blue-700 dark:text-blue-400",
  },
  processing: {
    label: "Processing",
    description: "being analyzed",
    Icon: LoaderCircle,
    className: "text-blue-700 dark:text-blue-400",
    spin: true,
  },
  stalled: {
    label: "Stalled",
    description: "processing never finished, can retry",
    Icon: TriangleAlert,
    className: "text-amber-700 dark:text-amber-400",
  },
  completed: {
    label: "Completed",
    description: "processed OK",
    Icon: CircleCheck,
    className: "text-green-700 dark:text-green-500",
  },
  failed: {
    label: "Failed",
    description: "error, can retry",
    Icon: CircleAlert,
    className: "text-destructive",
  },
  deleted: {
    label: "Deleted",
    description: "hidden from this run, can be restored",
    Icon: Trash2,
    className: DELETED_TEXT_CLASS,
  },
};

export const FILE_STATUS_LEGEND_SECTIONS: {
  key: FileStatusLegendSectionKey;
  title: string;
  statuses: FileStatusDisplayKey[];
}[] = [
  {
    key: "waiting",
    title: "Waiting",
    statuses: ["not_uploaded", "waiting_upload", "uploaded", "queued"],
  },
  {
    key: "in_motion",
    title: "In motion",
    statuses: ["uploading", "processing", "stalled"],
  },
  {
    key: "done",
    title: "Done",
    statuses: ["completed", "failed", "upload_failed"],
  },
  {
    key: "removed",
    title: "Removed",
    statuses: ["deleted"],
  },
];
