"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatChart } from "@/components/watchers/heartbeat-chart";
import type { WatcherEventRow, WatcherHeartbeatRow } from "@/lib/api/watchers";
import { parseAsString, useQueryState } from "nuqs";

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

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="status">Status</TabsTrigger>
        <TabsTrigger value="configuration">Configuration</TabsTrigger>
      </TabsList>

      <TabsContent value="logs" className="flex flex-col gap-4">
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
      </TabsContent>

      <TabsContent value="status" className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-medium">Watcher Status</h3>
          <p className="text-xs text-muted-foreground">
            Activity and connectivity (last 24 hours)
          </p>
        </div>
        <HeartbeatChart heartbeats={heartbeats} />
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
