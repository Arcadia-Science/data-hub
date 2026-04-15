"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeregisterDialog } from "@/components/watchers/deregister-dialog";
import { statusBadge } from "@/components/watchers/status-badge";
import type { WatcherListItem } from "@/lib/api/watchers";
import { cn, formatRelativeTime } from "@/lib/utils";
import { SearchX } from "lucide-react";
import { useRouter } from "next/navigation";

export function WatchersTable({
  data,
  isDeregisteredView = false,
}: {
  data: WatcherListItem[];
  isDeregisteredView?: boolean;
}) {
  const router = useRouter();

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {isDeregisteredView
            ? "No deregistered watchers."
            : "No active watchers."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Watcher ID</TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Heartbeat</TableHead>
            {!isDeregisteredView && <TableHead className="w-[80px]" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const sb = statusBadge[row.effectiveStatus];
            return (
              <TableRow
                key={row.id}
                className={cn(
                  "cursor-pointer",
                  isDeregisteredView && "opacity-60"
                )}
                onClick={() => router.push(`/watchers/${row.id}`)}
              >
                <TableCell>
                  <span className="font-mono text-xs">
                    {row.id.slice(0, 8)}…
                  </span>
                </TableCell>
                <TableCell>
                  {row.instrumentDisplayName ? (
                    <span className="text-sm">{row.instrumentDisplayName}</span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground">
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
                  <Badge variant={sb.variant} className="text-[10px]">
                    {sb.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {row.lastHeartbeatAt
                      ? formatRelativeTime(row.lastHeartbeatAt)
                      : "—"}
                  </span>
                </TableCell>
                {!isDeregisteredView && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {!row.deletedAt && (
                      <DeregisterDialog
                        watcherId={row.id}
                        hostname={row.hostname}
                      />
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
