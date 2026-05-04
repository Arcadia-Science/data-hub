"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import Link from "next/link";

const MAX_RUN_ID_LENGTH = 48;

export function RunIdLabel({
  runId,
  href,
  isDeleted,
  className,
}: {
  runId: string;
  href?: string;
  isDeleted?: boolean;
  className?: string;
}) {
  const isTruncated = runId.length > MAX_RUN_ID_LENGTH;
  const display = isTruncated ? `${runId.slice(0, MAX_RUN_ID_LENGTH)}…` : runId;

  const labelClass = cn(
    "font-mono",
    isDeleted && "line-through",
    href &&
      "relative z-10 rounded-sm hover:underline focus-visible:underline focus-visible:outline-none",
    className
  );

  const label = href ? (
    <Link href={href} className={labelClass}>
      {display}
    </Link>
  ) : (
    <span className={labelClass}>{display}</span>
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
