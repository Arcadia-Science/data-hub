import { RelativeTime } from "@/components/dashboard/relative-time";
import { EditInstrumentDialog } from "@/components/instruments/edit-instrument-dialog";
import { RowActionsCell } from "@/components/instruments/row-actions-cell";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
import { StatusActions } from "@/components/instruments/status-actions";
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
import { SearchX } from "lucide-react";
import type { ReactNode } from "react";

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
        instrumentId={row.id}
        displayName={row.displayName}
        instrumentType={row.instrumentType}
      />
    </div>
  );
}

export function InstrumentsTable({
  data,
  footer,
  renderRowActions,
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
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No instruments configured yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>File Patterns</TableHead>
            <TableHead>Runs This Week</TableHead>
            <TableHead>Last Run</TableHead>
            {renderRowActions ? <TableHead className="w-[100px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const watcherStatus = getWatcherOnlineStatus(row);
            return (
              <ClickableRow
                key={row.id}
                href={`/instruments/${row.id}`}
                className="text-sm"
              >
                <TableCell>
                  <span className="font-medium">{row.displayName}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {row.runCount} total {row.runCount === 1 ? "run" : "runs"}
                  </span>
                </TableCell>
                <TableCell>
                  <WatcherStatusBadge
                    status={watcherStatus}
                    lastOnlineAt={row.lastWatcherHeartbeatAt}
                  />
                </TableCell>
                <TableCell>
                  {row.filePatterns.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {row.filePatterns.map((p) => (
                        <Badge
                          key={p}
                          variant="outline"
                          className="font-mono text-xs font-normal"
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
