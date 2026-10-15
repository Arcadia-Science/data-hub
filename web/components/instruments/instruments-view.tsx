"use client";

import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback } from "react";
import { InstrumentActions } from "@/components/instruments/instrument-actions";
import {
  InstrumentsTable,
  InstrumentsTableSkeleton,
} from "@/components/instruments/instruments-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { InstrumentListItem } from "@/lib/api/instruments";

const TABS = ["active", "pending", "retired"] as const;
type Tab = (typeof TABS)[number];

export function InstrumentsViewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading instruments" role="status">
      <Tabs defaultValue="active">
        <TabsList variant="line">
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="retired">Retired</TabsTrigger>
        </TabsList>
        <TabsContent className="mt-2" value="active">
          {/* Actions column omitted: it's admin-only and renders instantly,
              so a placeholder just adds flicker. */}
          <InstrumentsTableSkeleton />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// All partitions are pre-fetched on the server, so tab switching needs no
// refetch (the instrument catalogue is small). The tab lives in the URL so a
// reload or a shared link opens on the same one, and Back returns to the last.
export function InstrumentsView({
  activeData,
  pendingData,
  retiredData,
  notifications,
  isAdmin,
}: {
  activeData: InstrumentListItem[];
  pendingData: InstrumentListItem[];
  retiredData: InstrumentListItem[];
  notifications: {
    subscriptions: Map<string, boolean>;
    masterMuted: boolean;
  };
  isAdmin: boolean;
}) {
  const [tab, setTab] = useQueryState(
    "tab",
    parseAsStringLiteral(TABS)
      .withDefault("active")
      .withOptions({ history: "push" })
  );

  // `InstrumentActions` uses hooks, so render it as JSX, not a function call.
  // Memoized so tab switches don't hand the tables a fresh function each render.
  const renderRow = useCallback(
    (row: InstrumentListItem) => <InstrumentActions instrument={row} />,
    []
  );
  const renderRowActions = isAdmin ? renderRow : undefined;

  return (
    <Tabs onValueChange={(v) => setTab(v as Tab)} value={tab}>
      <TabsList variant="line">
        <TabsTrigger value="active">Active ({activeData.length})</TabsTrigger>
        <TabsTrigger value="pending">
          Pending ({pendingData.length})
        </TabsTrigger>
        <TabsTrigger value="retired">
          Retired ({retiredData.length})
        </TabsTrigger>
      </TabsList>
      <TabsContent className="mt-2" value="active">
        <InstrumentsTable
          data={activeData}
          emptyMessage="No active instruments."
          notifications={notifications}
          renderRowActions={renderRowActions}
        />
      </TabsContent>
      <TabsContent className="mt-2" value="pending">
        <InstrumentsTable
          data={pendingData}
          emptyMessage="No pending instruments."
          notifications={notifications}
          renderRowActions={renderRowActions}
        />
      </TabsContent>
      <TabsContent className="mt-2" value="retired">
        <InstrumentsTable
          data={retiredData}
          emptyMessage="No retired instruments."
          notifications={notifications}
          renderRowActions={renderRowActions}
        />
      </TabsContent>
    </Tabs>
  );
}
