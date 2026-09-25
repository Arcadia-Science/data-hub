"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Timestamp({
  className,
  dateTime,
  full,
  label,
}: {
  className?: string;
  dateTime: string;
  full: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className={cn(
            "relative z-10 cursor-default whitespace-nowrap tabular-nums",
            className
          )}
          dateTime={dateTime}
        >
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
