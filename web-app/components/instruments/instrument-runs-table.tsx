import { FileStatusSummary } from "@/components/dashboard/file-status-summary";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { SearchX } from "lucide-react";
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

// Shows at most 3 key-value pairs from the run's freeform JSON metadata
// to keep the table column compact; the future run detail page shows all.
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

export function InstrumentRunsTable({
  data,
  instrumentId,
  hasFilters,
}: {
  data: RunRow[];
  instrumentId: string;
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
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead>Metadata</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            return (
              <TableRow key={row.id} className={cn(isDeleted && "opacity-50")}>
                <TableCell>
                  {/* Links to the future run detail page (not yet built). */}
                  <Link
                    href={`/instruments/${instrumentId}/runs/${row.run_id}`}
                    className="hover:underline"
                  >
                    <span
                      className={cn(
                        "font-mono text-sm",
                        isDeleted && "line-through"
                      )}
                    >
                      {row.run_id}
                    </span>
                  </Link>
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
                <TableCell>
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] font-normal"
                  >
                    {row.source}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <RelativeTime date={row.created_at.toISOString()} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
