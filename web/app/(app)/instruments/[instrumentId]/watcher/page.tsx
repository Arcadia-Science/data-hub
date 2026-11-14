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
import { defaultWatcherSince } from "@/lib/watchers/since";

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

  return (
    <WatcherFrame
      data={data}
      isAdmin={session.user.isAdmin === true}
      tab="activity"
    >
      {data.watcher ? (
        <Suspense fallback={<WatcherActivitySkeleton />}>
          <WatcherActivity
            defaultSince={defaultWatcherSince(data.watcher.deletedAt, timeZone)}
            eventTypes={filters.event_type}
            page={filters.logs_page}
            since={filters.events_since}
            watcherId={data.watcher.id}
          />
        </Suspense>
      ) : null}
    </WatcherFrame>
  );
}
