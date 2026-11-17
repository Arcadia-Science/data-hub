"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunListRow } from "@/lib/api/instrument-runs";
import { deriveRunStatus, RUN_STATUS_META } from "@/lib/runs/run-status";
import { cn } from "@/lib/utils";

// Takes the row rather than one prop per count. Every runs-table variant
// passes the same `RunListRow`, so a new bucket is a change here alone.
export type RunStatusRow = Pick<
  RunListRow,
  | "error_messages"
  | "file_count"
  | "files_completed"
  | "files_failed"
  | "files_not_uploaded"
  | "files_processing"
  | "files_queued"
  | "files_stalled"
  | "files_upload_failed"
  | "files_uploaded"
  | "files_waiting_upload"
>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function RunStatusIcon({ run }: { run: RunStatusRow }) {
  const status = deriveRunStatus({
    filesCompleted: run.files_completed,
    filesFailed: run.files_failed,
    filesNotUploaded: run.files_not_uploaded,
    filesProcessing: run.files_processing,
    filesQueued: run.files_queued,
    filesStalled: run.files_stalled,
    filesUploadFailed: run.files_upload_failed,
    filesUploaded: run.files_uploaded,
    filesWaitingUpload: run.files_waiting_upload,
  });
  const { Icon, colorClassName, label, spin } = RUN_STATUS_META[status];

  // Tooltip lists every non-empty bucket in priority order, so a run reveals
  // its lower-priority states on hover even though the icon shows only the top.
  const lines: string[] = [];
  if (run.files_failed > 0) {
    if (run.error_messages.length > 0) {
      lines.push(...run.error_messages);
    } else {
      lines.push(`${plural(run.files_failed, "file")} failed`);
    }
  }
  if (run.files_stalled > 0) {
    lines.push(
      `${plural(run.files_stalled, "file")} stalled in processing — can be reprocessed`
    );
  }
  if (run.files_upload_failed > 0) {
    lines.push(
      `${plural(run.files_upload_failed, "file")} couldn't upload — see the run page`
    );
  }
  if (run.files_waiting_upload > 0) {
    lines.push(
      `${run.files_waiting_upload} of ${plural(run.file_count, "file")} waiting to upload`
    );
  }
  if (run.files_uploaded > 0) {
    lines.push(`${plural(run.files_uploaded, "file")} uploaded`);
  }
  if (run.files_queued > 0) {
    lines.push(`${plural(run.files_queued, "file")} queued for processing`);
  }
  if (run.files_processing > 0) {
    lines.push(`${plural(run.files_processing, "file")} processing`);
  }
  if (run.files_not_uploaded > 0) {
    lines.push(
      `${run.files_not_uploaded} of ${plural(run.file_count, "file")} only on the instrument PC`
    );
  }
  if (run.files_completed > 0) {
    lines.push(`${plural(run.files_completed, "file")} processed successfully`);
  }
  if (lines.length === 0) {
    lines.push("No files");
  }

  // Everything but the all-completed and no-files cases can run long (error
  // messages especially), so cap the width and let the text wrap.
  const needsWrapping = status !== "completed" && status !== "empty";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10 flex shrink-0">
          <Icon
            aria-hidden="true"
            className={cn("size-4", colorClassName, spin && "animate-spin")}
          />
          {/* The tooltip only opens on hover, so the status needs its own text. */}
          <span className="sr-only">Status: {label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className={cn(needsWrapping && "max-w-sm")} side="top">
        {lines.length === 1 ? (
          lines[0]
        ) : (
          <ul className="list-disc space-y-0.5 pl-4">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
