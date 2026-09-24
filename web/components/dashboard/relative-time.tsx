"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/date";
import { cn, formatRelativeTime } from "@/lib/utils";

export function RelativeTime({
  className,
  date,
}: {
  className?: string;
  date: string;
}) {
  const full = formatDateTime(new Date(date));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className={cn(
            "relative z-10 cursor-default whitespace-nowrap",
            className
          )}
          dateTime={date}
        >
          {formatRelativeTime(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
