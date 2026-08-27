"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import { cn } from "@/lib/utils";
import { FILE_STATUS_CONFIG, getFileStatusKey } from "./file-status-config";

export function FileStatusIndicator({ file }: { file: RunFileRow }) {
  const key = getFileStatusKey(file);
  const { label, Icon, className, spin } = FILE_STATUS_CONFIG[key];
  const showErrorTooltip = key === "failed" && !!file.errorMessage;
  let stalledTooltip: string | null = null;
  if (key === "stalled") {
    // Absolute, not relative: polling stops for stalled rows, so an "N minutes
    // ago" rendered here would sit frozen for as long as the tab stays open.
    stalledTooltip = file.processingStartedAt
      ? `Processing started ${formatDateTime(file.processingStartedAt)} and never finished. You can reprocess this file.`
      : "Processing never finished. You can reprocess this file.";
  }
  const tooltip = showErrorTooltip ? file.errorMessage : stalledTooltip;

  const indicator = (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 text-sm leading-none",
        className
      )}
      tabIndex={tooltip ? 0 : undefined}
    >
      <Icon className={cn("size-4 shrink-0", spin && "animate-spin")} />
      {label}
    </span>
  );

  if (!tooltip) {
    return indicator;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent align="center" className="max-w-sm" side="top">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
