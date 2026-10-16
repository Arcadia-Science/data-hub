import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { WatcherConfig } from "@/components/watchers/watcher-config";
import {
  WatcherDetailTabs,
  WatcherDetailTabsSkeleton,
} from "@/components/watchers/watcher-detail-tabs";
import {
  WatcherHeader,
  WatcherHeaderSkeleton,
} from "@/components/watchers/watcher-header";
import {
  getAllWatcherHeartbeats,
  getWatcherById,
  getWatcherEvents,
  WATCHER_PAGE_SIZE,
} from "@/lib/api/watchers";
import { auth } from "@/lib/auth";
import { loginHref } from "@/lib/callback-url";
import { todayDateString } from "@/lib/date";
import { getRequestPath } from "@/lib/request-path";
import { watcherDetailParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type WatcherDetailFilters = Awaited<
  ReturnType<typeof watcherDetailParamsCache.parse>
>;

interface Props {
  params: Promise<{ watcherId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The viewer's zone is a guess on a first visit, so query from a day early to
// cover their whole local day. `<HeartbeatChart>` clips to the exact day, and
// the event log orders by timestamp, so a wider window is harmless.
function toTzSafeSince(dateString: string): Date {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { watcherId } = await params;
  const watcher = await getWatcherById(watcherId);
  const title = watcher?.hostname || `Watcher ${watcherId.slice(0, 8)}`;
  const description = `Connection status, recent uploads, and config for ${title}.`;
  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function WatcherDetailPage({
  params,
  searchParams,
}: Props) {
  const session = await auth();
  if (!session) {
    redirect(loginHref(await getRequestPath()));
  }

  const { watcherId } = await params;
  const filters = watcherDetailParamsCache.parse(await searchParams);

  const isAdmin = session.user.isAdmin === true;

  // The header and the heartbeat/events tabs stream independently; the shared
  // `getWatcherById` lookup is `cache()`-deduped so both sections resolve
  // against a single query while their heavier data fetches run in parallel.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-3.5 pb-6 2xl:w-6xl">
      {/* `pt-3.5` centers the breadcrumbs on the sidebar's "Navigation" label. */}
      <Suspense fallback={<WatcherHeaderSkeleton />}>
        <WatcherHeaderSection isAdmin={isAdmin} watcherId={watcherId} />
      </Suspense>
      <Suspense fallback={<WatcherDetailTabsSkeleton />}>
        <WatcherTabsSection filters={filters} watcherId={watcherId} />
      </Suspense>
    </div>
  );
}

async function WatcherHeaderSection({
  watcherId,
  isAdmin,
}: {
  watcherId: string;
  isAdmin: boolean;
}) {
  const watcher = await getWatcherById(watcherId);
  if (!watcher) {
    notFound();
  }
  return <WatcherHeader isAdmin={isAdmin} watcher={watcher} />;
}

async function WatcherTabsSection({
  watcherId,
  filters,
}: {
  watcherId: string;
  filters: WatcherDetailFilters;
}) {
  const timeZone = await getViewerTimeZone();
  const effectiveSince = filters.since ?? todayDateString(timeZone);
  const heartbeatSince = toTzSafeSince(effectiveSince);

  const effectiveEventsSince =
    filters.events_since ?? todayDateString(timeZone);
  const eventsSince = toTzSafeSince(effectiveEventsSince);

  // `getWatcherById` is `cache()`-deduped, so this shares the header section's
  // fetch rather than issuing a second query for `configYaml`.
  const [watcher, heartbeats, eventResult] = await Promise.all([
    getWatcherById(watcherId),
    // Up to 5000 rows, and only the Status tab draws them. The tab lives in the
    // URL, so the other tabs skip the query and the payload.
    filters.tab === "status"
      ? getAllWatcherHeartbeats(watcherId, { since: heartbeatSince })
      : Promise.resolve(null),
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
