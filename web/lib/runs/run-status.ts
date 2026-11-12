import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";

// Order is the single source of truth for status priority, shared by the icon
// and the exclusive SQL predicates in `buildRunListQuery`. Highest first.
//
// `stalled` sits directly under `failed` because both need an operator to act.
// A run that also has files waiting to upload would otherwise read as
// "pending" and hide the stall, and the pending files resolve on their own.
//
// `queued` sits between `uploaded` and `processing`: queued files are waiting
// for a free processing slot, so a run with both queued and processing files
// still reads as waiting.
export const RUN_STATUS_VALUES = [
  "failed",
  "stalled",
  "pending",
  "uploaded",
  "queued",
  "processing",
  "completed",
  "empty",
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export interface RunStatusMeta {
  colorClassName: string;
  description: string;
  Icon: LucideIcon;
  label: string;
  spin?: boolean;
}

export const RUN_STATUS_META: Record<RunStatus, RunStatusMeta> = {
  failed: {
    label: "Failed",
    description: "One or more files failed processing",
    Icon: CircleX,
    colorClassName: "text-destructive",
  },
  stalled: {
    label: "Stalled",
    description: "Processing never finished — the files can be reprocessed",
    Icon: TriangleAlert,
    colorClassName: "text-amber-600 dark:text-amber-500",
  },
  pending: {
    label: "Pending upload",
    description: "Files are waiting on the instrument PC to be uploaded",
    Icon: Clock,
    colorClassName: "text-amber-500",
  },
  uploaded: {
    label: "Uploaded",
    description: "Files are uploaded and waiting for their first processing",
    Icon: CircleDashed,
    colorClassName: "text-muted-foreground",
  },
  queued: {
    label: "Queued",
    description:
      "Files are queued for reprocessing and start when a processing slot is free",
    Icon: Hourglass,
    colorClassName: "text-muted-foreground",
  },
  processing: {
    label: "Processing",
    description: "Files are actively being processed",
    Icon: LoaderCircle,
    colorClassName: "text-sky-500",
    spin: true,
  },
  completed: {
    label: "Completed",
    description: "All files processed successfully",
    Icon: CircleCheck,
    colorClassName: "text-green-600 dark:text-green-500",
  },
  empty: {
    label: "Empty",
    description: "Run has no files",
    Icon: Circle,
    colorClassName: "text-muted-foreground",
  },
};

export const RUN_STATUS_OPTIONS = RUN_STATUS_VALUES.map((value) => ({
  value,
  ...RUN_STATUS_META[value],
}));

export interface RunStatusCounts {
  filesCompleted: number;
  filesFailed: number;
  filesPendingUpload: number;
  // Only files still inside the stall window. `processing` rows past it are
  // counted in `filesStalled` instead, so the two buckets stay exclusive.
  filesProcessing: number;
  filesQueued: number;
  filesStalled: number;
  filesUploaded: number;
}

// Keep the priority order in sync with the SQL predicates in
// `buildRunListQuery`. Every non-deleted raw file falls into one bucket (the
// `file_status` enum has no other values), so `empty` needs no `fileCount`.
export function deriveRunStatus(counts: RunStatusCounts): RunStatus {
  if (counts.filesFailed > 0) {
    return "failed";
  }
  if (counts.filesStalled > 0) {
    return "stalled";
  }
  if (counts.filesPendingUpload > 0) {
    return "pending";
  }
  if (counts.filesUploaded > 0) {
    return "uploaded";
  }
  if (counts.filesQueued > 0) {
    return "queued";
  }
  if (counts.filesProcessing > 0) {
    return "processing";
  }
  if (counts.filesCompleted > 0) {
    return "completed";
  }
  return "empty";
}
