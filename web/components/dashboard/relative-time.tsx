"use client";

import { Timestamp } from "@/components/timestamp";
import { formatDateTime } from "@/lib/date";
import { formatRelativeTime } from "@/lib/utils";

export function RelativeTime({ date }: { date: string }) {
  return (
    <Timestamp
      dateTime={date}
      full={formatDateTime(new Date(date))}
      label={formatRelativeTime(date)}
    />
  );
}
