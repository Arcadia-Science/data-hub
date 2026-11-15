"use client";

import dynamic from "next/dynamic";
import { useQueryStates } from "nuqs";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { TablePendingProvider } from "@/components/table-pending";
import { HeartbeatChartSkeleton } from "@/components/watchers/heartbeat-chart-skeleton";
import { StatusToolbar } from "@/components/watchers/status-toolbar";
import type { WatcherHeartbeatRow } from "@/lib/api/watchers";
import { watcherDetailSearchParams } from "@/lib/search-params";

// The chart brings in the charting library, which only this tab needs, and a
// chart can't be drawn on the server.
const HeartbeatChart = dynamic(
  () =>
    import("@/components/watchers/heartbeat-chart").then(
      (m) => m.HeartbeatChart
    ),
  { ssr: false, loading: () => <HeartbeatChartSkeleton /> }
);

export function WatcherHealthSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading health"
      className="flex flex-col gap-4"
      role="status"
    >
      <HeartbeatChartSkeleton />
    </div>
  );
}

/**
 * The Health tab: the selected watcher's heartbeats on the day the URL names.
 * The page loads the heartbeats only on this route.
 */
export function WatcherHealth({
  heartbeats,
  defaultSince,
}: {
  heartbeats: WatcherHeartbeatRow[];
  /** The day the chart opens on when the URL names none. */
  defaultSince: string;
}) {
  const [{ since }] = useQueryStates(watcherDetailSearchParams);

  return (
    <TablePendingProvider>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium text-sm">Status</h2>
          <StatusToolbar defaultSince={defaultSince} />
        </div>
        <LoadErrorBoundary>
          <HeartbeatChart
            heartbeats={heartbeats}
            since={since ?? defaultSince}
          />
        </LoadErrorBoundary>
      </div>
    </TablePendingProvider>
  );
}
