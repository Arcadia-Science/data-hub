"use client";

import { InstrumentNotificationSwitch } from "@/components/notifications/instrument-notification-switch";
import { TableCell } from "@/components/ui/table";

/**
 * Thin client wrapper around `<InstrumentNotificationSwitch>` for the
 * `<InstrumentsTable>` row. Lives in its own component because the table
 * is a Server Component and can't directly attach `onClick` handlers
 * across the boundary — the wrapping `<TableCell>` stops click bubbling
 * so toggling the switch doesn't navigate the parent `<ClickableRow>`.
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
    <TableCell onClick={(e) => e.stopPropagation()}>
      <InstrumentNotificationSwitch
        instrumentId={instrumentId}
        initialEnabled={initialEnabled}
        masterMuted={masterMuted}
        size="sm"
      />
    </TableCell>
  );
}
