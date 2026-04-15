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

import type { RunsTableProps } from ".";
import { ClickableRow } from "./clickable-row";

// Shows at most 3 key-value pairs from the run's freeform JSON metadata
// to keep the table column compact; the run detail page shows all.
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
          className="max-w-[200px] truncate font-mono font-normal"
        >
          {key}: {String(value)}
        </Badge>
      ))}
    </div>
  );
}

export function DefaultRunsTable({ data, instrumentId }: RunsTableProps) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead>Metadata</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            return (
              <ClickableRow
                key={row.id}
                href={`/instruments/${instrumentId}/runs/${encodeURIComponent(row.run_id)}`}
                className={cn(isDeleted && "opacity-50")}
              >
                <TableCell>
                  <span
                    className={cn("font-mono", isDeleted && "line-through")}
                  >
                    {row.run_id}
                  </span>
                  {isDeleted && (
                    <Badge variant="outline" className="ml-1.5 font-normal">
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
                  <RelativeTime date={row.created_at.toISOString()} />
                </TableCell>
              </ClickableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
