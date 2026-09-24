"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function TimeOfDay({
  dateTime,
  full,
  label,
}: {
  dateTime: string;
  full: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className="relative z-10 cursor-default whitespace-nowrap tabular-nums"
          dateTime={dateTime}
        >
          {label}
        </time>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  );
}
