"use client";

import { TablePendingProvider } from "@/components/table-pending";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatChart } from "@/components/watchers/heartbeat-chart";
import { StatusToolbar } from "@/components/watchers/status-toolbar";
import type { WatcherEventRow, WatcherHeartbeatRow } from "@/lib/api/watchers";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";

export function WatcherDetailTabs({
  configTab,
  heartbeats,
  events,
  eventsTotal,
  eventsPage,
  eventsTotalPages,
}: {
  configTab: React.ReactNode;
  heartbeats: WatcherHeartbeatRow[];
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

  const effectiveSince = since ?? todayDateString();
  const statusSubtitle = `Activity and connectivity for ${new Date(effectiveSince + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4" variant="line">
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="status">Status</TabsTrigger>
        <TabsTrigger value="configuration">Configuration</TabsTrigger>
      </TabsList>

      <TabsContent value="logs" className="flex flex-col gap-4">
        <TablePendingProvider>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium">Event Log</h3>
              {eventsTotal > 0 && (
                <p className="text-xs text-muted-foreground">
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

      <TabsContent value="status" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Watcher Status</h3>
            <p className="text-xs text-muted-foreground">{statusSubtitle}</p>
          </div>
          <StatusToolbar />
        </div>
        <HeartbeatChart heartbeats={heartbeats} since={effectiveSince} />
      </TabsContent>

      <TabsContent value="configuration" className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-medium">Configuration</h3>
        </div>
        {configTab}
      </TabsContent>
    </Tabs>
  );
}
