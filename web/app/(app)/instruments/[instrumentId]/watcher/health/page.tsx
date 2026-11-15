import { Suspense } from "react";
import { WatcherFrame } from "@/components/watchers/watcher-frame";
import {
  WatcherHealth,
  WatcherHealthSkeleton,
} from "@/components/watchers/watcher-health";
import { getAllWatcherHeartbeats } from "@/lib/api/watchers";
import { watcherDetailParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import {
  loadWatcherPage,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";
import { defaultWatcherSince, tzSafeSince } from "@/lib/watchers/since";

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

  return (
    <WatcherFrame
      data={data}
      isAdmin={session.user.isAdmin === true}
      tab="health"
    >
      {data.watcher ? (
        <Suspense fallback={<WatcherHealthSkeleton />}>
          <WatcherHealthSection
            defaultSince={defaultWatcherSince(data.watcher.deletedAt, timeZone)}
            since={filters.since}
            watcherId={data.watcher.id}
          />
        </Suspense>
      ) : null}
    </WatcherFrame>
  );
}

async function WatcherHealthSection({
  watcherId,
  since,
  defaultSince,
}: {
  watcherId: string;
  since: string | null;
  defaultSince: string;
}) {
  const heartbeats = await getAllWatcherHeartbeats(watcherId, {
    since: tzSafeSince(since ?? defaultSince),
  });
  return <WatcherHealth defaultSince={defaultSince} heartbeats={heartbeats} />;
}
