import { RelativeTime } from "@/components/dashboard/relative-time";
import { RanByCell } from "@/components/instruments/runs-table/ran-by-cell";
import { RawFileColumnHeader } from "@/components/instruments/runs-table/raw-file-column-header";
import { RunIdLabel } from "@/components/instruments/runs-table/run-id-label";
import { RunRowActions } from "@/components/instruments/runs-table/run-row-actions";
import {
  RunSelectAllCheckbox,
  RunSelectCheckbox,
} from "@/components/instruments/runs-table/run-select-checkbox";
import type { RunRef } from "@/components/instruments/runs-table/run-selection-provider";
import { RunStatusIcon } from "@/components/instruments/runs-table/run-status-icon";
import { RunsTableFooter } from "@/components/instruments/runs-table/runs-table-footer";
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
import type { RunListRow } from "@/lib/api/instrument-runs";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";
import { SearchX } from "lucide-react";

export function RunsTable({
  data,
  hasFilters,
  totalCount,
  pendingUploadCount,
  unattributedCount,
  ranByYouCount,
}: {
  data: RunListRow[];
  hasFilters: boolean;
  totalCount: number;
  pendingUploadCount: number;
  unattributedCount: number;
  ranByYouCount: number;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {hasFilters
            ? "No runs match your filters."
            : "No instrument runs yet."}
        </p>
      </div>
    );
  }

  const runRefs: RunRef[] = data.map(runRowToRef);

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <RunSelectAllCheckbox refs={runRefs} />
            </TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Run ID</TableHead>
            <TableHead>
              <RawFileColumnHeader label="Files" />
            </TableHead>
            <TableHead className="text-right">
              <RawFileColumnHeader label="Size" />
            </TableHead>
            <TableHead>Ran By</TableHead>
            <TableHead className="text-right">Created</TableHead>
            <TableHead className="w-[132px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            const href = `/instruments/${row.instrument_id}/runs/${encodeURIComponent(row.run_id)}`;
            return (
              <TableRow
                key={row.id}
                className={cn("group", isDeleted && "opacity-50")}
              >
                <TableCell>
                  <RunSelectCheckbox runRef={runRowToRef(row)} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {row.instrument_display_name}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <RunStatusIcon
                      fileCount={row.file_count}
                      filesCompleted={row.files_completed}
                      filesFailed={row.files_failed}
                      filesPendingUpload={row.files_pending_upload}
                      filesUploaded={row.files_uploaded}
                      filesProcessing={row.files_processing}
                      errorMessages={row.error_messages}
                    />
                    <RunIdLabel
                      runId={row.run_id}
                      href={href}
                      isDeleted={isDeleted}
                      className="text-sm"
                    />
                    {isDeleted ? (
                      <Badge
                        variant="outline"
                        className="ml-1.5 text-[10px] font-normal"
                      >
                        deleted
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm tabular-nums">
                  {row.file_count}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatBytes(row.total_size_bytes)}
                </TableCell>
                <TableCell>
                  <RanByCell
                    instrumentId={row.instrument_id}
                    runId={row.run_id}
                    attributions={row.attributions}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <RelativeTime date={new Date(row.created_at).toISOString()} />
                </TableCell>
                <TableCell className="py-1">
                  <RunRowActions row={row} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <RunsTableFooter
        shownCount={data.length}
        totalCount={totalCount}
        pendingUploadCount={pendingUploadCount}
        unattributedCount={unattributedCount}
        ranByYouCount={ranByYouCount}
      />
    </div>
  );
}

export function RunsTableSkeleton() {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Instrument</TableHead>
            <TableHead>Run ID</TableHead>
            <TableHead>
              <RawFileColumnHeader label="Files" />
            </TableHead>
            <TableHead className="text-right">
              <RawFileColumnHeader label="Size" />
            </TableHead>
            <TableHead>Ran By</TableHead>
            <TableHead className="text-right">Created</TableHead>
            <TableHead className="w-[132px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="size-4" />
              </TableCell>
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
              <TableCell>
                <Skeleton className="h-6 w-16" />
              </TableCell>
              <TableCell className="text-right">
                <Skeleton className="ml-auto h-4 w-20" />
              </TableCell>
              <TableCell />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
