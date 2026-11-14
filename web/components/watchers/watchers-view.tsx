"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ActiveWatchersTable,
  DeregisteredWatchersTable,
  WatchersTableSkeleton,
} from "@/components/watchers/watchers-table";
import type { WatcherRosterItem } from "@/lib/api/watcher-roster";

export function WatchersViewSkeleton() {
  return <WatchersTableSkeleton />;
}

const TABS = ["active", "deregistered"] as const;
type Tab = (typeof TABS)[number];

// Both lists are read on the server and passed down, so switching tabs needs no
// refetch. The tab lives in the URL (`?tab=deregistered`), so a reload or a
// shared link opens on the same one, and Back returns to the last.
export function WatchersView({
  activeData,
  deregisteredData,
}: {
  activeData: WatcherRosterItem[];
  deregisteredData: WatcherRosterItem[];
}) {
  const [tab, setTab] = useQueryState(
    "tab",
    parseAsStringLiteral(TABS)
      .withDefault("active")
      .withOptions({ history: "push" })
  );

  return (
    <Tabs onValueChange={(value) => setTab(value as Tab)} value={tab}>
      <TabsList aria-label="Watcher lists" variant="line">
        <TabsTrigger value="active">
          {`Active (${activeData.length})`}
        </TabsTrigger>
        <TabsTrigger value="deregistered">
          {`Deregistered (${deregisteredData.length})`}
        </TabsTrigger>
      </TabsList>
      <TabsContent className="mt-2" value="active">
        <ActiveWatchersTable rows={activeData} />
      </TabsContent>
      <TabsContent className="mt-2" value="deregistered">
        <DeregisteredWatchersTable rows={deregisteredData} />
      </TabsContent>
    </Tabs>
  );
}
