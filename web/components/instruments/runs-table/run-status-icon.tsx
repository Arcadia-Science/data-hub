"use client";

import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  const hasFailed = filesFailed > 0;
  const hasProcessing = filesProcessing > 0;
  const hasUploaded = filesUploaded > 0;
  const hasPending = filesPendingUpload > 0;
  const hasCompleted = filesCompleted > 0;

  // Icon priority: Error > Processing > Completed > Uploaded > Pending upload.
  // Fallback (no files at all) shows the healthy "completed" icon.
  const icon = hasFailed ? (
    <CircleX className="size-4 text-destructive" />
  ) : hasProcessing ? (
    <LoaderCircle className="size-4 animate-spin text-sky-500" />
  ) : hasCompleted ? (
    <CircleCheck className="size-4 text-green-600 dark:text-green-500" />
  ) : hasUploaded ? (
    <CircleDashed className="size-4 text-muted-foreground" />
  ) : hasPending ? (
    <Clock className="size-4 text-amber-500" />
  ) : (
    <CircleCheck className="size-4 text-green-600 dark:text-green-500" />
  );

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
    lines.push(
      `${filesUploaded} file${filesUploaded > 1 ? "s" : ""} awaiting processing`
    );
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
    lines.push("All files processed successfully");
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10 flex shrink-0">{icon}</span>
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
