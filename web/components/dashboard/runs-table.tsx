import { SearchX } from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { AcquiredColumnHeader } from "@/components/instruments/runs-table/acquired-column-header";
import { FilterableColumnHeader } from "@/components/instruments/runs-table/filterable-column-header";
import type { RanByOption } from "@/components/instruments/runs-table/index";
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

export function RunsTable({
  data,
  hasFilters,
  totalCount,
  pendingUploadCount,
  unattributedCount,
  ranByYouCount,
  ranByOptions,
  ranByLabel,
  emptyLabel = "No instrument runs yet.",
}: {
  data: RunListRow[];
  hasFilters: boolean;
  totalCount: number;
  pendingUploadCount: number;
  unattributedCount: number;
  ranByYouCount: number;
  // When provided, the "Ran By" column becomes a filterable dropdown bound to
  // the dashboard `ran_by` search param. Omitted on a member's runs page, where
  // every row is the same user, so a plain header is rendered instead.
  ranByOptions?: RanByOption[];
  // Footer suffix for the ran-by count; third-person on another member's page.
  ranByLabel?: string;
  // Copy shown when there are no rows and no active filters. Overridden on a
  // member's runs page, where "No instrument runs yet." would misdescribe the
  // user-scoped list.
  emptyLabel?: string;
}) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          {hasFilters ? "No runs match your filters." : emptyLabel}
        </p>
      </div>
    );
  }

  const runRefs: RunRef[] = data.map(runRowToRef);

  return (
    // `isolate` contains the rows' internal `z-10` (status icon / run-id link)
    // so they don't paint over the fixed sidebar, which shares `z-10`.
    <div className="isolate rounded-lg border bg-background dark:bg-muted">
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
            <TableHead>
              {ranByOptions ? (
                <FilterableColumnHeader
                  label="Ran By"
                  options={ranByOptions}
                  paramKey="ran_by"
                  paramsSource="dashboard"
                />
              ) : (
                "Ran By"
              )}
            </TableHead>
            <TableHead className="text-right">
              <AcquiredColumnHeader />
            </TableHead>
            <TableHead className="w-[108px]">
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
                className={cn("group", isDeleted && "opacity-50")}
                key={row.id}
              >
                <TableCell>
                  <RunSelectCheckbox runRef={runRowToRef(row)} />
                </TableCell>
                <TableCell>
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-sm font-medium text-sm hover:underline focus-visible:underline focus-visible:outline-none"
                    href={`/instruments/${row.instrument_id}`}
                  >
                    {row.instrument_display_name}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <RunStatusIcon
                      errorMessages={row.error_messages}
                      fileCount={row.file_count}
                      filesCompleted={row.files_completed}
                      filesFailed={row.files_failed}
                      filesPendingUpload={row.files_pending_upload}
                      filesProcessing={row.files_processing}
                      filesUploaded={row.files_uploaded}
                    />
                    <RunIdLabel
                      className="text-sm"
                      href={href}
                      isDeleted={isDeleted}
                      runId={row.run_id}
                    />
                    {isDeleted ? (
                      <Badge
                        className="ml-1.5 font-normal text-[10px]"
                        variant="outline"
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
                    attributions={row.attributions}
                    instrumentId={row.instrument_id}
                    runId={row.run_id}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <RelativeTime
                    date={new Date(
                      row.acquired_at ?? row.created_at
                    ).toISOString()}
                  />
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
        pendingUploadCount={pendingUploadCount}
        ranByLabel={ranByLabel}
        ranByYouCount={ranByYouCount}
        shownCount={data.length}
        totalCount={totalCount}
        unattributedCount={unattributedCount}
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
            <TableHead className="text-right">
              <AcquiredColumnHeader />
            </TableHead>
            <TableHead className="w-[108px]" />
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

function RunsToolbarSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </div>
  );
}

function RunsTableEmptyPlaceholder() {
  return (
    <div
      aria-hidden
      className="rounded-lg border border-dashed bg-background py-16 dark:bg-muted"
    />
  );
}

// Dashboard default is often an empty filtered run list (24h lookback) with the
// toolbar above it — not a populated table — so mirror that shell here.
export function DashboardRunsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading recent runs"
      className="flex flex-col gap-3"
      role="status"
    >
      <RunsToolbarSkeleton />
      <RunsTableEmptyPlaceholder />
    </div>
  );
}
