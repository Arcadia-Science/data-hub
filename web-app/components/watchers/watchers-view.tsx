"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WatchersTable } from "@/components/watchers/watchers-table";
import type { WatcherListItem } from "@/lib/api/watchers";
import { useState } from "react";

type Tab = "active" | "deregistered";

// Both partitions are pre-fetched on the server and passed down, so toggling
// between Active / Deregistered is purely client-side (no URL state or
// refetch needed — the watcher count is small enough to hold both in memory).
export function WatchersView({
  activeData,
  deregisteredData,
}: {
  activeData: WatcherListItem[];
  deregisteredData: WatcherListItem[];
}) {
  const [tab, setTab] = useState<Tab>("active");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <TabsList variant="line">
        <TabsTrigger value="active">Active ({activeData.length})</TabsTrigger>
        <TabsTrigger value="deregistered">
          Deregistered ({deregisteredData.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active" className="mt-2">
        <WatchersTable data={activeData} />
      </TabsContent>
      <TabsContent value="deregistered" className="mt-2">
        <WatchersTable data={deregisteredData} isDeregisteredView />
      </TabsContent>
    </Tabs>
  );
}
