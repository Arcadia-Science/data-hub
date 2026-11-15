"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ActiveWatchersTable,
  DeregisteredWatchersTable,
  WatchersTableSkeleton,
} from "@/components/watchers/watchers-table";
import type {
  ActiveWatcherRow,
  DeregisteredWatcherRow,
} from "@/lib/watchers/roster";

// The loaded layout without its data: the tab bar (labels only, no counts) and
// the active table's columns, so the list doesn't shift when it arrives.
export function WatchersViewSkeleton() {
  return (
    <Tabs value="active">
      <TabsList aria-hidden="true" variant="line">
        <TabsTrigger disabled tabIndex={-1} value="active">
          Active
        </TabsTrigger>
        <TabsTrigger disabled tabIndex={-1} value="deregistered">
          Deregistered
        </TabsTrigger>
      </TabsList>
      <div className="mt-2">
        <WatchersTableSkeleton />
      </div>
    </Tabs>
  );
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
  activeData: ActiveWatcherRow[];
  deregisteredData: DeregisteredWatcherRow[];
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
