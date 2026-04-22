"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const MAX_RUN_ID_LENGTH = 48;

export function RunIdLabel({
  runId,
  isDeleted,
  className,
}: {
  runId: string;
  isDeleted?: boolean;
  className?: string;
}) {
  const isTruncated = runId.length > MAX_RUN_ID_LENGTH;
  const display = isTruncated ? `${runId.slice(0, MAX_RUN_ID_LENGTH)}…` : runId;

  const label = (
    <span className={cn("font-mono", isDeleted && "line-through", className)}>
      {display}
    </span>
  );

  if (!isTruncated) return label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-md font-mono break-all">
        {runId}
      </TooltipContent>
    </Tooltip>
  );
}
