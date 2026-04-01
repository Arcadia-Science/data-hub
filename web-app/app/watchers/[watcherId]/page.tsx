import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatTable } from "@/components/watchers/heartbeat-table";
import { WatcherConfig } from "@/components/watchers/watcher-config";
import { WatcherHeader } from "@/components/watchers/watcher-header";
import {
  getWatcherById,
  getWatcherEvents,
  getWatcherHeartbeats,
} from "@/lib/api/watchers";
import { auth } from "@/lib/auth";
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

  // undefined defers to the data layer's default 24h lookback window, which
  // avoids calling Date.now() in the render path (React purity rule).
  const heartbeatSince = filters.since ? new Date(filters.since) : undefined;
  const eventsSince = filters.events_since
    ? new Date(filters.events_since)
    : undefined;

  // Three independent queries — none depends on the others' results.
  const [watcher, heartbeats, events] = await Promise.all([
    getWatcherById(watcherId),
    getWatcherHeartbeats(watcherId, { since: heartbeatSince }),
    getWatcherEvents(watcherId, {
      since: eventsSince,
      eventTypes:
        filters.event_type.length > 0 ? filters.event_type : undefined,
    }),
  ]);

  if (!watcher) notFound();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <WatcherHeader watcher={watcher} />
      <WatcherConfig configYaml={watcher.configYaml} />
      <HeartbeatTable heartbeats={heartbeats} />
      <EventLogToolbar />
      <EventLog events={events} />
    </div>
  );
}
