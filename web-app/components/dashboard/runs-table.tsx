import { RelativeTime } from "@/components/dashboard/relative-time";
import { RunStatusIcon } from "@/components/instruments/runs-table/run-status-icon";
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
import { cn, formatBytes } from "@/lib/utils";
import { FlaskConical, SearchX } from "lucide-react";
import Link from "next/link";

type RunRow = {
  id: string;
  instrument_id: string;
  instrument_display_name: string;
  run_id: string;
  source: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  file_count: number;
  files_completed: number;
  files_failed: number;
  files_pending_upload: number;
  total_size_bytes: number;
  error_messages: string[];
};

export function RunsTable({
  data,
  hasFilters,
}: {
  data: RunRow[];
  hasFilters: boolean;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {hasFilters
            ? "No runs match your filters."
            : "No instrument runs yet."}
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
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead className="text-right">Total Size</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            const href = `/instruments/${row.instrument_id}/runs/${encodeURIComponent(row.run_id)}`;
            return (
              <TableRow
                key={row.id}
                className={cn("group relative", isDeleted && "opacity-50")}
              >
                <TableCell>
                  <Link href={href} className="absolute inset-0" tabIndex={-1}>
                    <span className="sr-only">View run {row.run_id}</span>
                  </Link>
                  <div className="flex items-center gap-1.5">
                    <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {row.instrument_display_name}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <RunStatusIcon filesFailed={row.files_failed} errorMessages={row.error_messages} />
                    <span
                      className={cn(
                        "font-mono text-sm",
                        isDeleted && "line-through"
                      )}
                    >
                      {row.run_id}
                    </span>
                    {isDeleted && (
                      <Badge
                        variant="outline"
                        className="ml-1.5 text-[10px] font-normal"
                      >
                        deleted
                      </Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {row.file_count}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatBytes(row.total_size_bytes)}
                </TableCell>
                <TableCell className="text-right">
                  <RelativeTime date={new Date(row.created_at).toISOString()} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function RunsTableSkeleton() {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead className="text-right">Total Size</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-28" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-36" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-24" />
              </TableCell>
              <TableCell className="text-right">
                <Skeleton className="ml-auto h-4 w-16" />
              </TableCell>
              <TableCell className="text-right">
                <Skeleton className="ml-auto h-4 w-20" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
