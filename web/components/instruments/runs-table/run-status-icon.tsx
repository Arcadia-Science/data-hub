"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { deriveRunStatus, RUN_STATUS_META } from "@/lib/runs/run-status";
import { cn } from "@/lib/utils";

export function RunStatusIcon({
  fileCount,
  filesCompleted,
  filesFailed,
  filesPendingUpload,
  filesUploaded,
  filesProcessing,
  errorMessages,
}: {
  fileCount: number;
  filesCompleted: number;
  filesFailed: number;
  filesPendingUpload: number;
  filesUploaded: number;
  filesProcessing: number;
  errorMessages: string[];
}) {
  const status = deriveRunStatus({
    filesCompleted,
    filesFailed,
    filesPendingUpload,
    filesUploaded,
    filesProcessing,
  });
  const { Icon, colorClassName, spin } = RUN_STATUS_META[status];

  const hasFailed = filesFailed > 0;
  const hasPending = filesPendingUpload > 0;
  const hasUploaded = filesUploaded > 0;
  const hasProcessing = filesProcessing > 0;
  const hasCompleted = filesCompleted > 0;

  // Tooltip lists every non-empty bucket in priority order, so a run reveals
  // its lower-priority states on hover even though the icon shows only the top.
  const lines: string[] = [];
  if (hasFailed) {
    if (errorMessages.length > 0) {
      lines.push(...errorMessages);
    } else {
      lines.push(`${filesFailed} file${filesFailed > 1 ? "s" : ""} failed`);
    }
  }
  if (hasPending) {
    lines.push(
      `${filesPendingUpload} of ${fileCount} file${fileCount === 1 ? "" : "s"} pending upload`
    );
  }
  if (hasUploaded) {
    lines.push(`${filesUploaded} file${filesUploaded > 1 ? "s" : ""} uploaded`);
  }
  if (hasProcessing) {
    lines.push(
      `${filesProcessing} file${filesProcessing > 1 ? "s" : ""} processing`
    );
  }
  if (hasCompleted) {
    lines.push(
      `${filesCompleted} file${filesCompleted > 1 ? "s" : ""} processed successfully`
    );
  }
  if (lines.length === 0) {
    lines.push("No files");
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10 flex shrink-0">
          <Icon
            className={cn("size-4", colorClassName, spin && "animate-spin")}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent
        className={cn(
          (hasFailed || hasPending || hasUploaded || hasProcessing) &&
            "max-w-sm"
        )}
        side="top"
      >
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
