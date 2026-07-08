"use client";

import { useState } from "react";
import { InstrumentActions } from "@/components/instruments/instrument-actions";
import {
  InstrumentsTable,
  InstrumentsTableSkeleton,
} from "@/components/instruments/instruments-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { InstrumentListItem } from "@/lib/api/instruments";

type Tab = "active" | "pending" | "retired";

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
          {/* The trailing actions column is intentionally omitted from the
              skeleton: it's admin-only and its three-dot menu renders
              instantly once the row data streams in, so a placeholder there
              just adds flicker. */}
          <InstrumentsTableSkeleton withNotifications />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Both partitions are pre-fetched on the server and passed down, so switching
// tabs is purely client-side (no refetch — the instrument catalogue is small
// enough to hold in memory, mirroring the watchers view).
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
  const [tab, setTab] = useState<Tab>("active");

  // `InstrumentActions` uses hooks, so it must be rendered as JSX rather
  // than invoked as a plain function. Only admins get row actions.
  const renderRowActions = isAdmin
    ? (row: InstrumentListItem) => <InstrumentActions instrument={row} />
    : undefined;

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
