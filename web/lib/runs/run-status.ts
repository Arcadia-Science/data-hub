import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

// Order is the single source of truth for status priority, shared by the icon
// and the exclusive SQL predicates in `buildRunListQuery`. Highest first.
export const RUN_STATUS_VALUES = [
  "failed",
  "pending",
  "uploaded",
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
  pending: {
    label: "Pending upload",
    description: "Files are waiting on the instrument PC to be uploaded",
    Icon: Clock,
    colorClassName: "text-amber-500",
  },
  uploaded: {
    label: "Awaiting processing",
    description: "Files are uploaded and waiting in the processing queue",
    Icon: CircleDashed,
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
  fileCount: number;
  filesCompleted: number;
  filesFailed: number;
  filesPendingUpload: number;
  filesProcessing: number;
  filesUploaded: number;
}

// Collapse per-run file aggregates into one status. Mirrors the SQL predicates:
// a run with files always hits a bucket, so `empty` only fires at zero files.
export function deriveRunStatus(counts: RunStatusCounts): RunStatus {
  if (counts.filesFailed > 0) {
    return "failed";
  }
  if (counts.filesPendingUpload > 0) {
    return "pending";
  }
  if (counts.filesUploaded > 0) {
    return "uploaded";
  }
  if (counts.filesProcessing > 0) {
    return "processing";
  }
  if (counts.filesCompleted > 0) {
    return "completed";
  }
  return "empty";
}
