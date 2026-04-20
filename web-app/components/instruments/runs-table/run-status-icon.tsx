"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CircleCheck, CircleX } from "lucide-react";

export function RunStatusIcon({
  filesFailed,
  errorMessages,
}: {
  filesFailed: number;
  errorMessages: string[];
}) {
  const hasFailed = filesFailed > 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10 flex shrink-0">
          {hasFailed ? (
            <CircleX className="size-4 text-destructive" />
          ) : (
            <CircleCheck className="size-4 text-green-600 dark:text-green-500" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className={cn(hasFailed && "max-w-sm")}>
        {hasFailed
          ? errorMessages.length > 0
            ? errorMessages.join("; ")
            : `${filesFailed} file${filesFailed > 1 ? "s" : ""} failed`
          : "All files processed successfully"}
      </TooltipContent>
    </Tooltip>
  );
}
