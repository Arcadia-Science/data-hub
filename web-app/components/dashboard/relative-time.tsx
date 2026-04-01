"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatRelativeTime } from "@/lib/utils";

export function RelativeTime({ date }: { date: string }) {
  const full = new Date(date).toLocaleString();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={date} className="cursor-default whitespace-nowrap">
          {formatRelativeTime(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
