import { Suspense } from "react";
import { WatcherFrame } from "@/components/watchers/watcher-frame";
import {
  WatcherHealth,
  WatcherHealthSkeleton,
} from "@/components/watchers/watcher-health";
import { watcherDetailParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import {
  loadWatcherPage,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";
import {
  MAX_HEALTH_DAYS,
  pickerFallback,
  resolveWatcherRange,
  startOfDay,
} from "@/lib/watchers/range";
import { watcherPageHref } from "@/lib/watchers/routes";

interface Props {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The watcher page's Health tab. Heartbeats are read only on this route. */
export default async function WatcherHealthPage({
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

  // A past watcher sent nothing lately, so its default range ends on the day it
  // was deregistered.
  const deregisteredAt = data.watcher?.deletedAt ?? null;
  const range = resolveWatcherRange(
    {
      dateFrom: filters.date_from,
      dateTo: filters.date_to,
      legacySince: filters.since,
    },
    { timeZone, deregisteredAt, maxDays: MAX_HEALTH_DAYS }
  );

  // The Activity tab, listing this range's failed uploads. It keeps `?watcher=`
  // when this page's URL had it, like the sub-tab links do.
  const failuresHref = watcherPageHref(data.instrument.id, {
    tab: "activity",
    watcherId: data.selection.requested
      ? (data.selection.selected?.id ?? null)
      : null,
    params: {
      event_type: "upload_failed",
      date_from: range.start.toISOString(),
      date_to: startOfDay(range.toDay, timeZone).toISOString(),
    },
  });

  return (
    <WatcherFrame
      data={data}
      isAdmin={session.user.isAdmin === true}
      tab="health"
    >
      {data.watcher ? (
        <Suspense fallback={<WatcherHealthSkeleton />}>
          <WatcherHealth
            deregisteredAt={deregisteredAt}
            failuresHref={failuresHref}
            range={range}
            rangeFallback={pickerFallback(
              range,
              timeZone,
              deregisteredAt !== null
            )}
            timeZone={timeZone}
            watcherId={data.watcher.id}
          />
        </Suspense>
      ) : null}
    </WatcherFrame>
  );
}
