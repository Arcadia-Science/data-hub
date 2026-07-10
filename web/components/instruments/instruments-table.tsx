import { ArrowRight, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { RowActionsCell } from "@/components/instruments/row-actions-cell";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
import { InstrumentNotificationsCell } from "@/components/notifications/instrument-notifications-cell";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
 * Placeholder that mirrors `InstrumentsTable` column layout and row height
 * (two-line instrument cell, badge-sized status/patterns, notify switch,
 * optional actions) so streamed content swaps in without layout shift.
 */
export function InstrumentsTableSkeleton({
  rows = 8,
  withNotifications = true,
  withRowActions = false,
  withFooter = false,
  footerLabel,
  ariaLabel = "Loading instruments",
}: {
  rows?: number;
  withNotifications?: boolean;
  withRowActions?: boolean;
  withFooter?: boolean;
  footerLabel?: string;
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
            <TableHead>Status</TableHead>
            <TableHead>File Patterns</TableHead>
            <TableHead>Runs This Week</TableHead>
            <TableHead>Last Run</TableHead>
            {withNotifications ? (
              <TableHead className="w-[80px]">Notify</TableHead>
            ) : null}
            {withRowActions ? <TableHead className="w-[100px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow className="text-sm" key={i}>
              <TableCell>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-0.5 h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-8" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              {withNotifications ? (
                <TableCell>
                  <Skeleton className="h-3.5 w-6 rounded-full" />
                </TableCell>
              ) : null}
              {withRowActions ? (
                <TableCell>
                  <Skeleton className="h-8 w-16" />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {withFooter ? (
        <div className="border-t">
          <div className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-muted-foreground text-sm">
            {footerLabel ?? <Skeleton className="h-4 w-44" />}
            {footerLabel ? <ArrowRight className="size-3.5" /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function InstrumentsTable({
  data,
  footer,
  renderRowActions,
  notifications,
  emptyMessage = "No instruments configured yet.",
}: {
  data: InstrumentListItem[];
  /** Message shown in the empty state; per-tab callers override the default. */
  emptyMessage?: string;
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
            // Active + no live watcher but a deregistered one reads as
            // "Deregistered" rather than "No Watcher".
            const watcherStatus =
              row.watcherCount === 0 && row.hasDeregisteredWatcher
                ? "deregistered"
                : getWatcherOnlineStatus(row);
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
                  {row.status === "active" ? (
                    <WatcherStatusBadge
                      lastOnlineAt={row.lastWatcherHeartbeatAt}
                      status={watcherStatus}
                    />
                  ) : (
                    <InstrumentStatusBadge status={row.status} />
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
