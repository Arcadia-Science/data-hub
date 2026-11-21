"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import { deletedTooltip } from "@/lib/runs/deleted-file-note";
import { cn } from "@/lib/utils";
import { FILE_STATUS_CONFIG, getFileStatusKey } from "./file-status-config";

export function FileStatusIndicator({ file }: { file: RunFileRow }) {
  const timeZone = useViewerTimeZone();
  const key = getFileStatusKey(file);
  const { label, Icon, className, spin } = FILE_STATUS_CONFIG[key];
  // A failed file carries why processing failed; an upload_failed file carries
  // why the watcher gave up on it.
  const showErrorTooltip =
    (key === "failed" || key === "upload_failed") && !!file.errorMessage;
  let stalledTooltip: string | null = null;
  if (key === "stalled") {
    // Absolute, not relative: polling stops for stalled rows, so an "N minutes
    // ago" rendered here would sit frozen for as long as the tab stays open.
    stalledTooltip = file.processingStartedAt
      ? `Processing started ${formatDateTime(file.processingStartedAt, timeZone)} and never finished. You can reprocess this file.`
      : "Processing never finished. You can reprocess this file.";
  }
  // Who deleted a file, and when, shows on hover and on keyboard focus.
  const deletedNote =
    key === "deleted" && file.deletedAt !== null
      ? deletedTooltip(
          { deleter: file.deleter, deletedAt: file.deletedAt },
          timeZone
        )
      : null;
  const tooltip =
    deletedNote ?? (showErrorTooltip ? file.errorMessage : stalledTooltip);

  const indicatorClass = cn(
    "inline-flex h-6 items-center gap-1.5 text-sm leading-none",
    className
  );
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", spin && "animate-spin")}
      />
      {label}
    </>
  );

  if (!tooltip) {
    return <span className={indicatorClass}>{content}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            indicatorClass,
            "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
          type="button"
        >
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent align="center" className="max-w-sm" side="top">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
