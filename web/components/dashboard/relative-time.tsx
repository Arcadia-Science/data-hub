"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";

export function RelativeTime({ date }: { date: string }) {
  const full = formatDateTime(new Date(date));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className="relative z-10 cursor-default whitespace-nowrap"
          dateTime={date}
        >
          {formatRelativeTime(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
