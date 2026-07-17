import { SearchX } from "lucide-react";
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
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import type { WatcherListItem } from "@/lib/api/watchers";
import { cn, formatRelativeTime } from "@/lib/utils";

/**
 * Placeholder mirroring `WatchersTable` columns and row height (mono ID,
 * badge-sized status, deregister action) so streamed content swaps in
 * without layout shift.
 */
export function WatchersTableSkeleton({
  rows = 7,
  withActions = true,
  ariaLabel = "Loading watchers",
}: {
  rows?: number;
  withActions?: boolean;
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
            <TableHead>Watcher ID</TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Heartbeat</TableHead>
            {withActions ? <TableHead className="w-[80px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
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
              {withActions ? (
                <TableCell>
                  <Skeleton className="h-7 w-24" />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function WatchersTable({
  data,
  isDeregisteredView = false,
  isAdmin = false,
}: {
  data: WatcherListItem[];
  isDeregisteredView?: boolean;
  /** Admins get the inline Deregister action on active rows. */
  isAdmin?: boolean;
}) {
  const showActions = !isDeregisteredView && isAdmin;

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          {isDeregisteredView
            ? "No deregistered watchers."
            : "No active watchers."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Watcher ID</TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Heartbeat</TableHead>
            {showActions ? <TableHead className="w-[80px]" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => (
            <ClickableRow
              className={cn(isDeregisteredView && "opacity-60")}
              href={`/watchers/${row.id}`}
              key={row.id}
            >
              <TableCell>
                <span className="font-mono text-xs">{row.id.slice(0, 8)}…</span>
              </TableCell>
              <TableCell>
                {row.instrumentDisplayName ? (
                  <span className="text-sm">{row.instrumentDisplayName}</span>
                ) : (
                  <span className="font-mono text-muted-foreground text-xs">
                    {row.instrumentId}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-sm">
                  {row.hostname ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                {row.watcherVersion ? (
                  <span className="font-mono text-xs">
                    {row.watcherVersion}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <WatcherStatusBadge status={row.effectiveStatus} />
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground text-xs">
                  {row.lastHeartbeatAt
                    ? formatRelativeTime(row.lastHeartbeatAt)
                    : "—"}
                </span>
              </TableCell>
              {showActions ? (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {!row.deletedAt && (
                    <DeregisterDialog
                      hostname={row.hostname}
                      watcherId={row.id}
                    />
                  )}
                </TableCell>
              ) : null}
            </ClickableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
