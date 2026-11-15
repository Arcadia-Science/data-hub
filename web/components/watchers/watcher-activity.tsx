import { highlightCode } from "@/components/code-block";
import type { DateRange } from "@/components/runs/runs-date-filter";
import { TablePendingProvider } from "@/components/table-pending";
import { Skeleton } from "@/components/ui/skeleton";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { getStopsAfterUpdateStart } from "@/lib/api/watcher-health";
import { getWatcherEvents } from "@/lib/api/watchers";
import {
  WATCHER_EVENTS_MAX_SHOWN,
  WATCHER_EVENTS_PAGE_SIZE,
} from "@/lib/search-params";
import { describeEvent } from "@/lib/watchers/event-messages";
import { pluralize } from "@/lib/watchers/phrases";
import { describeRange, type WatcherRange } from "@/lib/watchers/range";

/** The event as the watcher sent it, as JSON and highlighted the same way. */
async function rawEvent(event: {
  eventType: string;
  message: string;
  details: unknown;
}) {
  const json = JSON.stringify(
    {
      event_type: event.eventType,
      message: event.message,
      details: event.details,
    },
    null,
    2
  );
  return { json, html: await highlightCode(json, "json") };
}

export function WatcherActivitySkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading activity"
      className="flex flex-col gap-4"
      role="status"
    >
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-44" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-36" />
        </div>
      </div>
      <div className="rounded-xl border border-dashed bg-card py-8" />
    </div>
  );
}

/**
 * The Activity tab: the selected watcher's event log for the days and event
 * types in the URL. Server component, so it reads its own events.
 */
export async function WatcherActivity({
  instrumentId,
  watcherId,
  range,
  rangeFallback,
  eventTypes,
  shown,
  timeZone,
  isAdmin,
}: {
  instrumentId: string;
  watcherId: string;
  range: WatcherRange;
  /** What the range picker shows when the URL names no range. */
  rangeFallback: DateRange;
  eventTypes: string[];
  /** How many events the URL asks to show. */
  shown: number;
  timeZone: string;
  isAdmin: boolean;
}) {
  const pageSize = Math.min(
    Math.max(shown, WATCHER_EVENTS_PAGE_SIZE),
    WATCHER_EVENTS_MAX_SHOWN
  );
  const events = await getWatcherEvents(watcherId, {
    since: range.start,
    until: range.endExclusive,
    eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
    // The Health tab's "Upload failures" card links here with this filter, and
    // counts only the files that failed, so the list leaves out the ones that
    // wait to be read again (they show with no filter, as "File not ready").
    excludeRetries: eventTypes.includes("upload_failed"),
    page: 1,
    pageSize,
  });

  // A stop is an update restart when it follows an update handed to the
  // upgrade worker, which its own message can't say.
  const stopsAfterUpdate = await getStopsAfterUpdateStart(
    watcherId,
    events.rows
      .filter((event) => event.eventType === "watcher_stopped")
      .map((event) => event.id)
  );

  const rows = await Promise.all(
    events.rows.map(async (event) => ({
      id: event.id,
      timestamp: event.timestamp.toISOString(),
      description: describeEvent({
        ...event,
        afterUpdateStart: stopsAfterUpdate.has(event.id),
      }),
      // Only an admin is shown the raw event, so only an admin is sent it.
      raw: isAdmin ? await rawEvent(event) : null,
    }))
  );

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">Event log</h2>
            <p className="text-muted-foreground text-sm">
              {pluralize(events.total, "event")}{" "}
              {describeRange(range, timeZone)}
            </p>
          </div>
          <EventLogToolbar rangeFallback={rangeFallback} />
        </div>
        <EventLog
          instrumentId={instrumentId}
          rows={rows}
          total={events.total}
        />
      </div>
    </TablePendingProvider>
  );
}
