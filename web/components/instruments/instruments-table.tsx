import { ArrowRight, SearchX } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EmptyState } from "@/components/empty-state";
import { FilePatterns } from "@/components/instruments/file-patterns";
import { InstrumentStatusBadge } from "@/components/instruments/instrument-status-badge";
import { InstrumentNotificationSwitch } from "@/components/notifications/instrument-notification-switch";
import { RowControl, RowLink } from "@/components/row-link";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
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
 * (two-line instrument cell, badge-sized status/patterns, optional notify
 * switch) so streamed content swaps in without layout shift.
 */
function InstrumentsTableSkeletonFrame({
  ariaLabel,
  footer,
  notifyColumn,
  rows,
}: {
  ariaLabel: string;
  footer?: ReactNode;
  notifyColumn: boolean;
  rows: number;
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
            {notifyColumn ? (
              <TableHead className="w-[80px]">Notify</TableHead>
            ) : null}
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
              {notifyColumn ? (
                <TableCell>
                  <Skeleton className="h-3.5 w-6 rounded-full" />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {footer ? <div className="border-t">{footer}</div> : null}
    </div>
  );
}

/** The full instruments list: every column, including Notify. */
export function InstrumentsTableSkeleton({
  rows = 8,
  ariaLabel = "Loading instruments",
}: {
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <InstrumentsTableSkeletonFrame
      ariaLabel={ariaLabel}
      notifyColumn
      rows={rows}
    />
  );
}

/** The short list on the dashboard: no Notify column, a "View all" footer. */
export function DashboardInstrumentsTableSkeleton({
  rows = 3,
  footerLabel,
}: {
  rows?: number;
  footerLabel: string;
}) {
  return (
    <InstrumentsTableSkeletonFrame
      ariaLabel="Loading instruments"
      footer={
        <div className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-muted-foreground text-sm">
          {footerLabel}
          <ArrowRight className="size-3.5" />
        </div>
      }
      notifyColumn={false}
      rows={rows}
    />
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
    return <EmptyState icon={SearchX}>{emptyMessage}</EmptyState>;
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
              <TableRow className="relative text-sm" key={row.id}>
                <TableCell>
                  <TruncatedTooltip text={row.displayName}>
                    <RowLink
                      className="block max-w-72 truncate font-medium"
                      href={`/instruments/${row.id}`}
                    >
                      {row.displayName}
                    </RowLink>
                  </TruncatedTooltip>
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    {row.runCount} total {row.runCount === 1 ? "run" : "runs"}
                  </span>
                </TableCell>
                <TableCell>
                  <RowControl>
                    {row.status === "active" ? (
                      <WatcherStatusBadge
                        lastOnlineAt={row.lastWatcherHeartbeatAt}
                        status={watcherStatus}
                      />
                    ) : (
                      <InstrumentStatusBadge status={row.status} />
                    )}
                  </RowControl>
                </TableCell>
                <TableCell>
                  <RowControl>
                    <FilePatterns maxVisible={2} patterns={row.filePatterns} />
                  </RowControl>
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
                  <TableCell>
                    <RowControl>
                      <InstrumentNotificationSwitch
                        initialEnabled={
                          notifications.subscriptions.get(row.id) ?? false
                        }
                        instrumentId={row.id}
                        masterMuted={notifications.masterMuted}
                        size="sm"
                      />
                    </RowControl>
                  </TableCell>
                ) : null}
                {renderRowActions ? (
                  <TableCell>
                    <RowControl>{renderRowActions(row)}</RowControl>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {footer ? <div className="border-t">{footer}</div> : null}
    </div>
  );
}
