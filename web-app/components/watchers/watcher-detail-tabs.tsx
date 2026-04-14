"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EventLog } from "@/components/watchers/event-log";
import { EventLogToolbar } from "@/components/watchers/event-log-toolbar";
import { HeartbeatTable } from "@/components/watchers/heartbeat-table";
import { WatcherConfig } from "@/components/watchers/watcher-config";
import type { WatcherEventRow, WatcherHeartbeatRow } from "@/lib/api/watchers";

export function WatcherDetailTabs({
  configYaml,
  heartbeats,
  heartbeatsTotal,
  heartbeatsPage,
  heartbeatsTotalPages,
  events,
  eventsTotal,
  eventsPage,
  eventsTotalPages,
}: {
  configYaml: string | null;
  heartbeats: WatcherHeartbeatRow[];
  heartbeatsTotal: number;
  heartbeatsPage: number;
  heartbeatsTotalPages: number;
  events: WatcherEventRow[];
  eventsTotal: number;
  eventsPage: number;
  eventsTotalPages: number;
}) {
  return (
    <Tabs defaultValue="logs">
      <TabsList className="mb-4">
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="heartbeats">Heartbeats</TabsTrigger>
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

      <TabsContent value="heartbeats" className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-medium">Heartbeat History</h3>
          <p className="text-xs text-muted-foreground">
            {heartbeatsTotal} heartbeat{heartbeatsTotal !== 1 && "s"} (last 24
            hours)
          </p>
        </div>
        <HeartbeatTable
          heartbeats={heartbeats}
          page={heartbeatsPage}
          totalPages={heartbeatsTotalPages}
        />
      </TabsContent>
      <TabsContent value="configuration" className="flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-medium">Configuration</h3>
        </div>
        <WatcherConfig configYaml={configYaml} />
      </TabsContent>
    </Tabs>
  );
}
