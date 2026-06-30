import { SearchX } from "lucide-react";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
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

export function WatchersTable({
  data,
  isDeregisteredView = false,
}: {
  data: WatcherListItem[];
  isDeregisteredView?: boolean;
}) {
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
            {!isDeregisteredView && <TableHead className="w-[80px]" />}
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
              {!isDeregisteredView && (
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {!row.deletedAt && (
                    <DeregisterDialog
                      hostname={row.hostname}
                      watcherId={row.id}
                    />
                  )}
                </TableCell>
              )}
            </ClickableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
