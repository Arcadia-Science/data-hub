"use client";

import { useCallback, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WatcherActions } from "@/components/watchers/watcher-actions";
import {
  WatchersTable,
  WatchersTableSkeleton,
} from "@/components/watchers/watchers-table";
import type { WatcherListItem } from "@/lib/api/watchers";

export function WatchersViewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading watchers" role="status">
      <Tabs defaultValue="active">
        <TabsList variant="line">
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="deregistered">Deregistered</TabsTrigger>
        </TabsList>
        <TabsContent className="mt-2" value="active">
          {/* Actions column omitted: it's admin-only and renders instantly,
              so a placeholder just adds flicker. */}
          <WatchersTableSkeleton />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Tab = "active" | "deregistered";

// Both partitions are pre-fetched on the server and passed down, so toggling
// between Active / Deregistered is purely client-side (no URL state or
// refetch needed — the watcher count is small enough to hold both in memory).
export function WatchersView({
  activeData,
  deregisteredData,
  isAdmin = false,
}: {
  activeData: WatcherListItem[];
  deregisteredData: WatcherListItem[];
  /** Admins get the row-actions menu on active watchers. */
  isAdmin?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("active");

  // `WatcherActions` uses hooks, so render it as JSX, not a function call.
  const renderRow = useCallback(
    (row: WatcherListItem) => <WatcherActions watcher={row} />,
    []
  );
  const renderRowActions = isAdmin ? renderRow : undefined;

  return (
    <Tabs onValueChange={(v) => setTab(v as Tab)} value={tab}>
      <TabsList variant="line">
        <TabsTrigger value="active">Active ({activeData.length})</TabsTrigger>
        <TabsTrigger value="deregistered">
          Deregistered ({deregisteredData.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent className="mt-2" value="active">
        <WatchersTable
          data={activeData}
          emptyMessage="No active watchers."
          renderRowActions={renderRowActions}
        />
      </TabsContent>
      <TabsContent className="mt-2" value="deregistered">
        <WatchersTable
          data={deregisteredData}
          emptyMessage="No deregistered watchers."
        />
      </TabsContent>
    </Tabs>
  );
}
