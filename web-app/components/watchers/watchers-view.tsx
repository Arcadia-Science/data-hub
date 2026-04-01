"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
    <>
      <div className="flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(v) => {
            if (v) setTab(v as Tab);
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="active">
            Active ({activeData.length})
          </ToggleGroupItem>
          <ToggleGroupItem value="deregistered">
            Deregistered ({deregisteredData.length})
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <WatchersTable
        data={tab === "active" ? activeData : deregisteredData}
        isDeregisteredView={tab === "deregistered"}
      />
    </>
  );
}
