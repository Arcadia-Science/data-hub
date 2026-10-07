"use client";

import { Timestamp } from "@/components/timestamp";
import { formatDateCompact, formatDateTime } from "@/lib/date";

// A client component because the labels depend on the viewer's time zone,
// which the server doesn't know when it renders the table.
export function SentDate({ date }: { date: string }) {
  const value = new Date(date);
  return (
    <Timestamp
      dateTime={date}
      full={formatDateTime(value)}
      label={formatDateCompact(value)}
    />
  );
}
