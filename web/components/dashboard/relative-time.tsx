"use client";

import { Timestamp } from "@/components/timestamp";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { formatDateTime } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";

export function RelativeTime({
  className,
  date,
}: {
  className?: string;
  date: string;
}) {
  const timeZone = useViewerTimeZone();

  return (
    <Timestamp
      className={className}
      dateTime={date}
      full={formatDateTime(new Date(date), timeZone)}
      label={formatRelativeTime(date)}
    />
  );
}
