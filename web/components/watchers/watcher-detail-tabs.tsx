"use client";

import dynamic from "next/dynamic";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { TablePendingProvider } from "@/components/table-pending";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatChartSkeleton } from "@/components/watchers/heartbeat-chart-skeleton";
import { StatusToolbar } from "@/components/watchers/status-toolbar";
import type { WatcherEventRow, WatcherHeartbeatRow } from "@/lib/api/watchers";
import { todayDateString } from "@/lib/date";
import { preloader } from "@/lib/preload";
import { watcherDetailSearchParams } from "@/lib/search-params";

// The chart brings in the charting library, which only the Status tab needs.
// Switching to that tab also waits for the server to send the heartbeats, so
// the download starts as soon as the tab is hovered, focused, or chosen.
const loadHeartbeatChart = () =>
  import("@/components/watchers/heartbeat-chart").then((m) => m.HeartbeatChart);
const preloadHeartbeatChart = preloader(loadHeartbeatChart);

const HeartbeatChart = dynamic(loadHeartbeatChart, {
  ssr: false,
  loading: () => <HeartbeatChartSkeleton />,
});

export function WatcherDetailTabsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading watcher details" role="status">
      <Tabs defaultValue="logs">
        <TabsList className="mb-4" variant="line">
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
        </TabsList>

        <TabsContent className="flex flex-col gap-4" value="logs">
          <EventLogSectionSkeleton />
        </TabsContent>
        <TabsContent className="flex flex-col gap-4" value="status">
          <StatusSectionSkeleton />
        </TabsContent>
        <TabsContent className="flex flex-col gap-4" value="configuration">
          <ConfigurationSectionSkeleton />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EventLogSectionSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Event Log</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
      <div className="rounded-md border border-dashed bg-background py-8 dark:bg-muted" />
    </>
  );
}

function StatusSectionSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Status</h3>
        <Skeleton className="h-8 w-36" />
      </div>
      <HeartbeatChartSkeleton />
    </>
  );
}

function ConfigurationSectionSkeleton() {
  return (
    <>
      <h3 className="font-medium text-sm">Configuration</h3>
      <div className="rounded-lg border border-dashed bg-background py-8 dark:bg-muted" />
    </>
  );
}

export function WatcherDetailTabs({
  configTab,
  heartbeats,
  events,
  eventsTotal,
  eventsPage,
  eventsTotalPages,
}: {
  configTab: React.ReactNode;
  // `null` while the server has not loaded them: heartbeats are only fetched
  // when the Status tab is the one in the URL.
  heartbeats: WatcherHeartbeatRow[] | null;
  events: WatcherEventRow[];
  eventsTotal: number;
  eventsPage: number;
  eventsTotalPages: number;
}) {
  const [tab, setTab] = useQueryState(
    "tab",
    parseAsString.withDefault("logs").withOptions({ shallow: false })
  );

  const [{ since }] = useQueryStates(watcherDetailSearchParams);

  const timeZone = useViewerTimeZone();
  const effectiveSince = since ?? todayDateString(timeZone);

  return (
    <Tabs
      onValueChange={(next) => {
        if (next === "status") {
          preloadHeartbeatChart();
        }
        setTab(next);
      }}
      value={tab}
    >
      <TabsList className="mb-4" variant="line">
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger
          onFocus={preloadHeartbeatChart}
          onPointerEnter={preloadHeartbeatChart}
          value="status"
        >
          Status
        </TabsTrigger>
        <TabsTrigger value="configuration">Configuration</TabsTrigger>
      </TabsList>

      <TabsContent className="flex flex-col gap-4" value="logs">
        <TablePendingProvider>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-sm">Event Log</h3>
              {eventsTotal > 0 && (
                <p className="text-muted-foreground text-xs">
                  {eventsTotal} event{eventsTotal !== 1 && "s"}
                </p>
              )}
            </div>
            <EventLogToolbar />
          </div>
          <EventLog
            events={events}
            page={eventsPage}
            totalPages={eventsTotalPages}
          />
        </TablePendingProvider>
      </TabsContent>

      <TabsContent className="flex flex-col gap-4" value="status">
        <TablePendingProvider>
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-sm">Status</h3>
            <StatusToolbar />
          </div>
          {heartbeats === null ? (
            <HeartbeatChartSkeleton />
          ) : (
            <LoadErrorBoundary>
              <HeartbeatChart heartbeats={heartbeats} since={effectiveSince} />
            </LoadErrorBoundary>
          )}
        </TablePendingProvider>
      </TabsContent>

      <TabsContent className="flex flex-col gap-4" value="configuration">
        <div>
          <h3 className="font-medium text-sm">Configuration</h3>
        </div>
        {configTab}
      </TabsContent>
    </Tabs>
  );
}
