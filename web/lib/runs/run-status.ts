import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  CloudAlert,
  HardDrive,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";

// Order is the single source of truth for status priority, shared by the icon
// and the exclusive SQL predicates in `buildRunListQuery`. Highest first.
//
// `failed`, `stalled` and `upload_failed` come first because each needs
// someone to act. A run that also has files waiting to upload would otherwise
// read as waiting and hide the problem, and waiting files resolve on their own.
//
// `waiting_upload` (requested, or an auto-mode watcher will upload it) is work
// in motion, so it sits above the processing states. `not_uploaded` (nothing
// will upload the file until someone asks) is a resting state, so it sits
// below them: a run whose requested files are processing reads "Processing",
// and one whose requested files are done reads "Not uploaded" while other
// files are still only on the instrument PC.
//
// `queued` sits between `uploaded` and `processing`: queued files are waiting
// for a free processing slot, so a run with both queued and processing files
// still reads as waiting.
export const RUN_STATUS_VALUES = [
  "failed",
  "stalled",
  "upload_failed",
  "waiting_upload",
  "uploaded",
  "queued",
  "processing",
  "not_uploaded",
  "completed",
  "empty",
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

// `pending` was one status for every file not yet in S3. It is still accepted
// as a status filter (REST, MCP, saved links) and means both statuses that
// replaced it. No run reports it.
export const DEPRECATED_PENDING_RUN_STATUS = "pending";
export const PENDING_RUN_STATUS_ALIAS: readonly RunStatus[] = [
  "waiting_upload",
  "not_uploaded",
];

// Expands the deprecated `pending` filter value; every other value passes
// through. Callers drop values that aren't run statuses.
export function expandRunStatusAlias(value: string): string[] {
  return value === DEPRECATED_PENDING_RUN_STATUS
    ? [...PENDING_RUN_STATUS_ALIAS]
    : [value];
}

// A status filter as callers send it (possibly with `pending`), as the run
// statuses it matches, without repeats.
export function expandRunStatusFilters(values: readonly string[]): RunStatus[] {
  const statuses = new Set<RunStatus>();
  for (const value of values) {
    for (const status of expandRunStatusAlias(value)) {
      if ((RUN_STATUS_VALUES as readonly string[]).includes(status)) {
        statuses.add(status as RunStatus);
      }
    }
  }
  return [...statuses];
}

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
  upload_failed: {
    label: "Upload failed",
    description:
      "The watcher couldn't upload some files, for example because they're no longer on the instrument PC",
    Icon: CloudAlert,
    colorClassName: "text-destructive",
  },
  waiting_upload: {
    label: "Waiting to upload",
    description:
      "Files are on their way from the instrument PC: someone requested them, or the watcher uploads them on its own",
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
  not_uploaded: {
    label: "Not uploaded",
    description:
      "Some files are only on the instrument PC, and nothing will upload them until someone requests them",
    Icon: HardDrive,
    colorClassName: "text-muted-foreground",
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
  // Not in S3, and nothing will upload them until someone requests them.
  filesNotUploaded: number;
  // Only files still inside the stall window. `processing` rows past it are
  // counted in `filesStalled` instead, so the two buckets stay exclusive.
  filesProcessing: number;
  filesQueued: number;
  filesStalled: number;
  filesUploaded: number;
  // The watcher gave up on them.
  filesUploadFailed: number;
  // Requested, or an auto-mode watcher said it will upload them.
  filesWaitingUpload: number;
}

// The run statuses that come from a run's raw files, in priority order. `empty`
// is the one that doesn't: it means the run has no raw files at all. Which file
// statuses count toward each one is `RUN_BUCKET_BY_FILE_STATUS` in
// `file-buckets.ts`.
export type RunFileBucket = Exclude<RunStatus, "empty">;

export const RUN_FILE_BUCKETS = RUN_STATUS_VALUES.filter(
  (status): status is RunFileBucket => status !== "empty"
);

// The counter that holds each bucket's file count.
const COUNT_FIELD_BY_BUCKET = {
  failed: "filesFailed",
  stalled: "filesStalled",
  upload_failed: "filesUploadFailed",
  waiting_upload: "filesWaitingUpload",
  uploaded: "filesUploaded",
  queued: "filesQueued",
  processing: "filesProcessing",
  not_uploaded: "filesNotUploaded",
  completed: "filesCompleted",
} as const satisfies Record<RunFileBucket, keyof RunStatusCounts>;

// The first bucket in priority order that holds a file. The runs-list status
// filter (`runStatusCondition` in `buildRunListQuery`) walks the same order.
// Every non-deleted raw file falls into one bucket, so `empty` needs no
// `fileCount`.
export function deriveRunStatus(counts: RunStatusCounts): RunStatus {
  for (const bucket of RUN_FILE_BUCKETS) {
    if (counts[COUNT_FIELD_BY_BUCKET[bucket]] > 0) {
      return bucket;
    }
  }
  return "empty";
}
