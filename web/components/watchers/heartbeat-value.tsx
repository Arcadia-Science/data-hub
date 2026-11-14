"use client";

import { RelativeTime } from "@/components/dashboard/relative-time";
import { Timestamp } from "@/components/timestamp";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { formatDateTime, formatDateTimeShort } from "@/lib/date";

/**
 * A watcher's last heartbeat. A current watcher reads relative ("3 minutes
 * ago"), since the question is how long it has been silent. A past watcher
 * reads as a date, since it will never check in again. Hover or focus shows the
 * exact time either way.
 */
export function HeartbeatValue({
  date,
  relative,
}: {
  date: Date | null;
  relative: boolean;
}) {
  const timeZone = useViewerTimeZone();

  if (!date) {
    return <span className="text-muted-foreground">Never</span>;
  }
  if (relative) {
    return <RelativeTime date={date.toISOString()} />;
  }
  return (
    <Timestamp
      dateTime={date.toISOString()}
      full={formatDateTime(date, timeZone)}
      label={formatDateTimeShort(date, timeZone)}
    />
  );
}
