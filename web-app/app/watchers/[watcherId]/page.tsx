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

  // The server and browser may be in different timezones, so the local-midnight
  // moment of a "yyyy-MM-dd" date can differ by up to ~14 hours from the
  // server's interpretation. Parse both date filters as UTC and step back one
  // day so the DB query is guaranteed to cover the user's full local day;
  // <HeartbeatChart> clips the chart precisely on the client, and the event log
  // already orders by timestamp so a slightly wider window is harmless.
  function toTzSafeSince(dateString: string): Date {
    const d = new Date(dateString + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }

  const effectiveSince = filters.since ?? todayDateString();
  const heartbeatSince = toTzSafeSince(effectiveSince);

  const effectiveEventsSince = filters.events_since ?? todayDateString();
  const eventsSince = toTzSafeSince(effectiveEventsSince);

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
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
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
