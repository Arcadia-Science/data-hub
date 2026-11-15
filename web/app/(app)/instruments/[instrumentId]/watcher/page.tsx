import { Suspense } from "react";
import {
  WatcherActivity,
  WatcherActivitySkeleton,
} from "@/components/watchers/watcher-activity";
import { WatcherFrame } from "@/components/watchers/watcher-frame";
import { watcherDetailParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import {
  loadWatcherPage,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";
import { pickerFallback, resolveWatcherRange } from "@/lib/watchers/range";

interface Props {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The watcher page's Activity tab, which is the page's default. */
export default async function WatcherActivityPage({
  params,
  searchParams,
}: Props) {
  const session = await requireWatcherPageSession();
  const { instrumentId } = await params;
  const query = await searchParams;
  // Before any Suspense boundary, so an unknown `?watcher=` is a real 404.
  const data = await loadWatcherPage(instrumentId, query.watcher);
  const filters = watcherDetailParamsCache.parse(query);
  const timeZone = await getViewerTimeZone();
  const isAdmin = session.user.isAdmin === true;

  // A past watcher sent nothing lately, so its default range ends on the day it
  // was deregistered.
  const deregisteredAt = data.watcher?.deletedAt ?? null;
  const range = resolveWatcherRange(
    {
      dateFrom: filters.date_from,
      dateTo: filters.date_to,
      legacySince: filters.events_since,
    },
    { timeZone, deregisteredAt }
  );

  return (
    <WatcherFrame data={data} isAdmin={isAdmin} tab="activity">
      {data.watcher ? (
        <Suspense fallback={<WatcherActivitySkeleton />}>
          <WatcherActivity
            eventTypes={filters.event_type}
            instrumentId={data.instrument.id}
            isAdmin={isAdmin}
            range={range}
            rangeFallback={pickerFallback(
              range,
              timeZone,
              deregisteredAt !== null
            )}
            shown={filters.shown}
            timeZone={timeZone}
            watcherId={data.watcher.id}
          />
        </Suspense>
      ) : null}
    </WatcherFrame>
  );
}
