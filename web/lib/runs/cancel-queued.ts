import type { RunFileStats } from "@/lib/api/instrument-runs";

// The run page offers "Cancel queued" while the run has files waiting in the
// reprocessing queue. It also does for a soft-deleted run, whose queued files
// cannot start. Files that have already started are not affected by it, so
// they do not count here.
export function canCancelQueued(stats: Pick<RunFileStats, "queued">): boolean {
  return stats.queued > 0;
}

// The toast after the request. The count can be lower than the number of files
// that showed as queued: a file may have started while the dialog was open.
export function cancelQueuedToast(filesCancelled: number): {
  kind: "success" | "info";
  message: string;
} {
  if (filesCancelled === 0) {
    return {
      kind: "info",
      message: "No files were waiting in the queue",
    };
  }
  return {
    kind: "success",
    message: `Cancelled ${filesCancelled} queued ${filesCancelled === 1 ? "file" : "files"}`,
  };
}
