import { PaginationNav } from "@/components/pagination-nav";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WatcherHeartbeatRow } from "@/lib/api/watchers";
import { cn } from "@/lib/utils";
import { HeartPulse } from "lucide-react";

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function HeartbeatTable({
  heartbeats,
  page,
  totalPages,
}: {
  heartbeats: WatcherHeartbeatRow[];
  page: number;
  totalPages: number;
}) {
  if (heartbeats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <HeartPulse className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No heartbeats in this time range.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Timestamp</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Upload Mode</TableHead>
            <TableHead className="text-right">Files</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="text-right">Uptime</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {heartbeats.map((hb) => (
            <TableRow key={hb.id}>
              <TableCell className="font-mono text-xs">
                {hb.timestamp.toLocaleString("en-US", {
                  dateStyle: "short",
                  timeStyle: "medium",
                })}
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-[10px]">
                  {hb.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {hb.uploadMode ?? "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {hb.filesUploadedSinceLast ?? 0}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {hb.runsReportedSinceLast ?? 0}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-xs",
                  (hb.errorsSinceLast ?? 0) > 0 &&
                    "font-semibold text-destructive"
                )}
              >
                {hb.errorsSinceLast ?? 0}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {hb.uptimeSeconds != null
                  ? formatDuration(hb.uptimeSeconds)
                  : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationNav page={page} totalPages={totalPages} pageParam="hb_page" />
    </div>
  );
}
