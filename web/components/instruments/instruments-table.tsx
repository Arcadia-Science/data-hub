import { SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EditInstrumentDialog } from "@/components/instruments/edit-instrument-dialog";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { RowActionsCell } from "@/components/instruments/row-actions-cell";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
import { StatusActions } from "@/components/instruments/status-actions";
import { InstrumentNotificationsCell } from "@/components/notifications/instrument-notifications-cell";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getWatcherOnlineStatus } from "@/components/watchers/watcher-online-status";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { InstrumentListItem } from "@/lib/api/instruments";

/**
 * Default row actions used by the management page: an approval action for
 * pending instruments and an edit dialog for everyone. Exported so the
 * `/instruments` page can pass it directly to `<InstrumentsTable renderRowActions={...} />`
 * while contexts without management intent (e.g. the dashboard) simply omit
 * the prop and the actions column disappears entirely.
 */
export function InstrumentRowManagementActions(row: InstrumentListItem) {
  return (
    <div className="flex items-center justify-end gap-1">
      {row.status === "pending" && <StatusActions instrumentId={row.id} />}
      <EditInstrumentDialog
        displayName={row.displayName}
        instrumentId={row.id}
        instrumentType={row.instrumentType}
      />
    </div>
  );
}

export function InstrumentsTable({
  data,
  footer,
  renderRowActions,
  notifications,
}: {
  data: InstrumentListItem[];
  /**
   * Optional content rendered inside the bordered container, below the table.
   * Used on the dashboard to surface a "View all" link beneath a truncated list.
   */
  footer?: ReactNode;
  /**
   * Optional per-row action cell. When omitted, the trailing actions column
   * is hidden entirely — useful for read-only contexts like the dashboard.
   */
  renderRowActions?: (row: InstrumentListItem) => ReactNode;
  /**
   * Per-instrument notification subscription state for the viewer, plus
   * the viewer's master-mute flag. Threaded in from the page so the
   * notifications column can render without a per-row client fetch.
   * Pass `null`/omit to hide the column entirely (used by the
   * dashboard's truncated table where the column would be noise).
   */
  notifications?: {
    subscriptions: Map<string, boolean>;
    masterMuted: boolean;
  };
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          No instruments configured yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>File Patterns</TableHead>
            <TableHead>Runs This Week</TableHead>
            <TableHead>Last Run</TableHead>
            {notifications ? (
              <TableHead className="w-[80px]">Notify</TableHead>
            ) : null}
            {renderRowActions ? <TableHead className="w-[100px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const watcherStatus = getWatcherOnlineStatus(row);
            return (
              <ClickableRow
                className="text-sm"
                href={`/instruments/${row.id}`}
                key={row.id}
              >
                <TableCell>
                  <span className="font-medium">{row.displayName}</span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    {row.runCount} total {row.runCount === 1 ? "run" : "runs"}
                  </span>
                </TableCell>
                <TableCell>
                  {row.status === "pending" ? (
                    <InstrumentStatusBadge status="pending" />
                  ) : (
                    <WatcherStatusBadge
                      lastOnlineAt={row.lastWatcherHeartbeatAt}
                      status={watcherStatus}
                    />
                  )}
                </TableCell>
                <TableCell>
                  {row.filePatterns.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {row.filePatterns.map((p) => (
                        <Badge
                          className="font-mono font-normal text-xs"
                          key={p}
                          variant="outline"
                        >
                          {p}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="font-mono">{row.runsThisWeek}</TableCell>
                <TableCell>
                  {row.lastRunAt ? (
                    <RelativeTime date={row.lastRunAt.toISOString()} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                {notifications ? (
                  <InstrumentNotificationsCell
                    initialEnabled={
                      notifications.subscriptions.get(row.id) ?? false
                    }
                    instrumentId={row.id}
                    masterMuted={notifications.masterMuted}
                  />
                ) : null}
                {renderRowActions ? (
                  <RowActionsCell>{renderRowActions(row)}</RowActionsCell>
                ) : null}
              </ClickableRow>
            );
          })}
        </TableBody>
      </Table>
      {footer ? <div className="border-t">{footer}</div> : null}
    </div>
  );
}
