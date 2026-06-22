"use client";

import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { TablePendingProvider } from "@/components/table-pending";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatChart } from "@/components/watchers/heartbeat-chart";
import { StatusToolbar } from "@/components/watchers/status-toolbar";
import type { WatcherEventRow, WatcherHeartbeatRow } from "@/lib/api/watchers";
import { todayDateString } from "@/lib/date";
import { watcherDetailSearchParams } from "@/lib/search-params";

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
  const statusSubtitle = `Activity and connectivity for ${new Date(`${effectiveSince}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;

  return (
    <Tabs onValueChange={setTab} value={tab}>
      <TabsList className="mb-4" variant="line">
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="status">Status</TabsTrigger>
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
            <div>
              <h3 className="font-medium text-sm">Watcher Status</h3>
              <p className="text-muted-foreground text-xs">{statusSubtitle}</p>
            </div>
            <StatusToolbar />
          </div>
          <HeartbeatChart heartbeats={heartbeats} since={effectiveSince} />
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
