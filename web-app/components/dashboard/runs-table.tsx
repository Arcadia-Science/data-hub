import { FileStatusSummary } from "@/components/dashboard/file-status-summary";
import { RelativeTime } from "@/components/dashboard/relative-time";
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
import { cn } from "@/lib/utils";
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
};

// Renders at most 3 key-value pairs from the run's freeform JSON metadata.
// This keeps the table column compact; a detail view can show the full object.
function MetadataSummary({ metadata }: { metadata: unknown }) {
  if (!metadata || typeof metadata !== "object") return null;
  const entries = Object.entries(metadata as Record<string, unknown>).slice(
    0,
    3
  );
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <Badge
          key={key}
          variant="outline"
          className="max-w-[200px] truncate font-mono text-[10px] font-normal"
        >
          {key}: {String(value)}
        </Badge>
      ))}
    </div>
  );
}

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
            <TableHead>Metadata</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            const href = `/instruments/${row.instrument_id}/runs/${row.run_id}`;
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
                </TableCell>
                <TableCell>
                  <FileStatusSummary
                    fileCount={row.file_count}
                    filesCompleted={row.files_completed}
                    filesFailed={row.files_failed}
                    filesPendingUpload={row.files_pending_upload}
                  />
                </TableCell>
                <TableCell>
                  <MetadataSummary metadata={row.metadata} />
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
            <TableHead>Metadata</TableHead>
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
              <TableCell>
                <Skeleton className="h-4 w-32" />
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
