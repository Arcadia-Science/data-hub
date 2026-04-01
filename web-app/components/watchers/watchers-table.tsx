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
import type { EffectiveStatus, WatcherListItem } from "@/lib/api/watchers";
import { cn, formatRelativeTime } from "@/lib/utils";
import { SearchX } from "lucide-react";
import Link from "next/link";

const statusBadge: Record<
  EffectiveStatus,
  {
    label: string;
    variant: "default" | "outline" | "secondary" | "destructive";
  }
> = {
  watching: { label: "Watching", variant: "default" },
  stale: { label: "Stale", variant: "destructive" },
  stopped: { label: "Stopped", variant: "secondary" },
  registered: { label: "Registered", variant: "outline" },
};

export function WatchersTable({
  data,
  isDeregisteredView = false,
}: {
  data: WatcherListItem[];
  isDeregisteredView?: boolean;
}) {
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
                className={cn(isDeregisteredView && "opacity-60")}
              >
                <TableCell>
                  <Link
                    href={`/watchers/${row.id}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {row.id.slice(0, 8)}…
                  </Link>
                </TableCell>
                <TableCell>
                  {row.instrumentDisplayName ? (
                    <Link
                      href={`/instruments/${row.instrumentId}`}
                      className="text-sm hover:underline"
                    >
                      {row.instrumentDisplayName}
                    </Link>
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
                  <TableCell>
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
