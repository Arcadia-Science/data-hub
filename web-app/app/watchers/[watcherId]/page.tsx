import { WatcherConfig } from "@/components/watchers/watcher-config";
import { WatcherDetailTabs } from "@/components/watchers/watcher-detail-tabs";
import { WatcherHeader } from "@/components/watchers/watcher-header";
import {
  WATCHER_PAGE_SIZE,
  getAllWatcherHeartbeats,
  getWatcherById,
  getWatcherEvents,
} from "@/lib/api/watchers";
import { auth } from "@/lib/auth";
import { todayDateString } from "@/lib/date";
import { watcherDetailParamsCache } from "@/lib/search-params";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next/types";

type Props = {
  params: Promise<{ watcherId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { watcherId } = await params;
  const watcher = await getWatcherById(watcherId);
  return {
    title: watcher?.hostname ?? watcherId.slice(0, 8),
  };
}

export default async function WatcherDetailPage({
  params,
  searchParams,
}: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { watcherId } = await params;
  const filters = watcherDetailParamsCache.parse(await searchParams);

  const effectiveSince = filters.since ?? todayDateString();
  const heartbeatSince = new Date(effectiveSince + "T00:00:00");
  const eventsSince = filters.events_since
    ? new Date(filters.events_since)
    : undefined;

  const [watcher, heartbeats, eventResult] = await Promise.all([
    getWatcherById(watcherId),
    getAllWatcherHeartbeats(watcherId, { since: heartbeatSince }),
    getWatcherEvents(watcherId, {
      since: eventsSince,
      eventTypes:
        filters.event_type.length > 0 ? filters.event_type : undefined,
      page: filters.logs_page,
    }),
  ]);

  if (!watcher) notFound();

  const logsTotalPages = Math.ceil(eventResult.total / WATCHER_PAGE_SIZE);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <WatcherHeader watcher={watcher} />
      <WatcherDetailTabs
        configTab={<WatcherConfig configYaml={watcher.configYaml} />}
        heartbeats={heartbeats}
        events={eventResult.rows}
        eventsTotal={eventResult.total}
        eventsPage={filters.logs_page}
        eventsTotalPages={logsTotalPages}
      />
    </div>
  );
}
