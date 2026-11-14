import { TablePendingProvider } from "@/components/table-pending";
import { Skeleton } from "@/components/ui/skeleton";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { getWatcherEvents, WATCHER_PAGE_SIZE } from "@/lib/api/watchers";
import { tzSafeSince } from "@/lib/watchers/since";

export function WatcherActivitySkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading activity"
      className="flex flex-col gap-4"
      role="status"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Event Log</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <div className="rounded-md border border-dashed bg-background py-8 dark:bg-muted" />
    </div>
  );
}

/**
 * The Activity tab: the selected watcher's event log, filtered by the URL.
 * Server component, so it reads its own events.
 */
export async function WatcherActivity({
  watcherId,
  since,
  defaultSince,
  eventTypes,
  page,
}: {
  watcherId: string;
  /** The `?events_since=` day (`yyyy-MM-dd`), or null for the default. */
  since: string | null;
  /** The day the log opens on when the URL names none. */
  defaultSince: string;
  eventTypes: string[];
  page: number;
}) {
  const events = await getWatcherEvents(watcherId, {
    since: tzSafeSince(since ?? defaultSince),
    eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
    page,
  });
  const totalPages = Math.ceil(events.total / WATCHER_PAGE_SIZE);

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium text-sm">Event Log</h2>
            {events.total > 0 && (
              <p className="text-muted-foreground text-xs">
                {events.total} event{events.total !== 1 && "s"}
              </p>
            )}
          </div>
          <EventLogToolbar defaultSince={defaultSince} />
        </div>
        <EventLog events={events.rows} page={page} totalPages={totalPages} />
      </div>
    </TablePendingProvider>
  );
}
