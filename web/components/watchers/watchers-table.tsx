import { SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { RowActionsCell } from "@/components/instruments/row-actions-cell";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { WatcherListItem } from "@/lib/api/watchers";
import { cn } from "@/lib/utils";

/**
 * Placeholder mirroring `WatchersTable` columns and row height so streamed
 * content swaps in without layout shift.
 */
export function WatchersTableSkeleton({
  rows = 7,
  ariaLabel = "Loading watchers",
}: {
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Heartbeat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow className="text-sm" key={i}>
              <TableCell>
                <Skeleton className="h-4 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-12" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function WatchersTable({
  data,
  emptyMessage = "No active watchers.",
  renderRowActions,
}: {
  data: WatcherListItem[];
  /** Message shown in the empty state; per-tab callers override the default. */
  emptyMessage?: string;
  /**
   * Optional per-row action cell. When omitted, the trailing actions column
   * is hidden entirely — used for the deregistered tab and for non-admins.
   */
  renderRowActions?: (row: WatcherListItem) => ReactNode;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Heartbeat</TableHead>
            {renderRowActions ? <TableHead className="w-[100px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <ClickableRow
              className={cn("text-sm", row.deletedAt && "opacity-60")}
              href={`/watchers/${row.id}`}
              key={row.id}
            >
              <TableCell>
                {row.instrumentDisplayName ? (
                  row.instrumentDisplayName
                ) : (
                  <span className="font-mono text-muted-foreground">
                    {row.instrumentId}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {row.hostname ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.watcherVersion ?? (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <WatcherStatusBadge
                  className="text-xs"
                  status={row.effectiveStatus}
                />
              </TableCell>
              <TableCell>
                {row.lastHeartbeatAt ? (
                  <RelativeTime date={row.lastHeartbeatAt.toISOString()} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              {renderRowActions ? (
                <RowActionsCell>{renderRowActions(row)}</RowActionsCell>
              ) : null}
            </ClickableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
