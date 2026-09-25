"use client";

import { Timestamp } from "@/components/timestamp";
import { formatDateTime } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";

export function RelativeTime({
  className,
  date,
}: {
  className?: string;
  date: string;
}) {
  return (
    <Timestamp
      className={className}
      dateTime={date}
      full={formatDateTime(new Date(date))}
      label={formatRelativeTime(date)}
    />
  );
}
