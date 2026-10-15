"use client";

import { InstrumentNotificationSwitch } from "@/components/notifications/instrument-notification-switch";
import { TableCell } from "@/components/ui/table";

/**
 * Thin client wrapper around `<InstrumentNotificationSwitch>` for the
 * `<InstrumentsTable>` row. It stays a separate client component because the
 * switch keeps its own state and the table is a Server Component.
 */
export function InstrumentNotificationsCell({
  instrumentId,
  initialEnabled,
  masterMuted,
}: {
  instrumentId: string;
  initialEnabled: boolean;
  masterMuted: boolean;
}) {
  return (
    <TableCell>
      <InstrumentNotificationSwitch
        initialEnabled={initialEnabled}
        instrumentId={instrumentId}
        masterMuted={masterMuted}
        size="sm"
      />
    </TableCell>
  );
}
