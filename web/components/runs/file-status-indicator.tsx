"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunFile } from "@/lib/api/instrument-runs";
import { cn } from "@/lib/utils";
import { FILE_STATUS_CONFIG, getFileStatusKey } from "./file-status-config";

export function FileStatusIndicator({ file }: { file: RunFile }) {
  const key = getFileStatusKey(file);
  const { label, Icon, className, spin } = FILE_STATUS_CONFIG[key];
  const showErrorTooltip = key === "failed" && !!file.errorMessage;

  const indicator = (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 text-sm leading-none",
        className
      )}
      tabIndex={showErrorTooltip ? 0 : undefined}
    >
      <Icon className={cn("size-4 shrink-0", spin && "animate-spin")} />
      {label}
    </span>
  );

  if (!showErrorTooltip) {
    return indicator;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent align="center" className="max-w-sm" side="top">
        {file.errorMessage}
      </TooltipContent>
    </Tooltip>
  );
}
