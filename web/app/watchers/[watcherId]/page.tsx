import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { HeartbeatChartSkeleton } from "@/components/watchers/heartbeat-chart";
import { WatcherConfig } from "@/components/watchers/watcher-config";
import { WatcherDetailTabs } from "@/components/watchers/watcher-detail-tabs";
import { WatcherHeader } from "@/components/watchers/watcher-header";
import {
  getAllWatcherHeartbeats,
  getWatcherById,
  getWatcherEvents,
  WATCHER_PAGE_SIZE,
} from "@/lib/api/watchers";
import { auth } from "@/lib/auth";
import { todayDateString } from "@/lib/date";
import { watcherDetailParamsCache } from "@/lib/search-params";

type WatcherDetailFilters = Awaited<
  ReturnType<typeof watcherDetailParamsCache.parse>
>;

interface Props {
  params: Promise<{ watcherId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The server and browser may be in different timezones, so the local-midnight
// moment of a "yyyy-MM-dd" date can differ by up to ~14 hours from the
// server's interpretation. Parse date filters as UTC and step back one day so
// the DB query is guaranteed to cover the user's full local day;
// `<HeartbeatChart>` clips the chart precisely on the client, and the event log
// already orders by timestamp so a slightly wider window is harmless.
function toTzSafeSince(dateString: string): Date {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

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
  if (!session) {
    redirect("/login");
  }

  const { watcherId } = await params;
  const filters = watcherDetailParamsCache.parse(await searchParams);

  // The header and the heartbeat/events tabs stream independently; the shared
  // `getWatcherById` lookup is `cache()`-deduped so both sections resolve
  // against a single query while their heavier data fetches run in parallel.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <Suspense fallback={<WatcherHeaderSkeleton />}>
        <WatcherHeaderSection watcherId={watcherId} />
      </Suspense>
      <Suspense
        fallback={
          <div className="flex flex-col gap-4">
            <Skeleton className="h-9 w-72" />
            <HeartbeatChartSkeleton />
          </div>
        }
      >
        <WatcherTabsSection filters={filters} watcherId={watcherId} />
      </Suspense>
    </div>
  );
}

function WatcherHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

async function WatcherHeaderSection({ watcherId }: { watcherId: string }) {
  const watcher = await getWatcherById(watcherId);
  if (!watcher) {
    notFound();
  }
  return <WatcherHeader watcher={watcher} />;
}

async function WatcherTabsSection({
  watcherId,
  filters,
}: {
  watcherId: string;
  filters: WatcherDetailFilters;
}) {
  const effectiveSince = filters.since ?? todayDateString();
  const heartbeatSince = toTzSafeSince(effectiveSince);

  const effectiveEventsSince = filters.events_since ?? todayDateString();
  const eventsSince = toTzSafeSince(effectiveEventsSince);

  // `getWatcherById` is `cache()`-deduped, so this shares the header section's
  // fetch rather than issuing a second query for `configYaml`.
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

  if (!watcher) {
    notFound();
  }

  const logsTotalPages = Math.ceil(eventResult.total / WATCHER_PAGE_SIZE);

  return (
    <WatcherDetailTabs
      configTab={<WatcherConfig configYaml={watcher.configYaml} />}
      events={eventResult.rows}
      eventsPage={filters.logs_page}
      eventsTotal={eventResult.total}
      eventsTotalPages={logsTotalPages}
      heartbeats={heartbeats}
    />
  );
}
