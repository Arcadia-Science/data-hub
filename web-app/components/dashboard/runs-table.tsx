import { RelativeTime } from "@/components/dashboard/relative-time";
import { ClickableRow } from "@/components/instruments/runs-table/clickable-row";
import { RanByCell } from "@/components/instruments/runs-table/ran-by-cell";
import {
  RunSelectAllCheckbox,
  RunSelectCheckbox,
} from "@/components/instruments/runs-table/run-select-checkbox";
import type { RunRef } from "@/components/instruments/runs-table/run-selection-provider";
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
import type { RunAttribution } from "@/lib/api/instrument-runs";
import { cn, formatBytes } from "@/lib/utils";
import { FlaskConical, SearchX } from "lucide-react";

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
  attributions: RunAttribution[];
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

  const runRefs: RunRef[] = data.map((row) => ({
    id: row.id,
    instrumentId: row.instrument_id,
    runId: row.run_id,
  }));

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <RunSelectAllCheckbox refs={runRefs} />
            </TableHead>
            <TableHead>Instrument</TableHead>
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead className="text-right">Total Size</TableHead>
            <TableHead>Ran By</TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            const href = `/instruments/${row.instrument_id}/runs/${encodeURIComponent(row.run_id)}`;
            return (
              <ClickableRow
                key={row.id}
                href={href}
                className={cn(isDeleted && "opacity-50")}
              >
                <TableCell>
                  <RunSelectCheckbox
                    runRef={{
                      id: row.id,
                      instrumentId: row.instrument_id,
                      runId: row.run_id,
                    }}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {row.instrument_display_name}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <RunStatusIcon
                      filesFailed={row.files_failed}
                      errorMessages={row.error_messages}
                    />
                    <span
                      className={cn(
                        "font-mono text-sm",
                        isDeleted && "line-through"
                      )}
                    >
                      {row.run_id}
                    </span>
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
              </ClickableRow>
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
            <TableHead className="w-10" />
            <TableHead>Instrument</TableHead>
            <TableHead>Run ID</TableHead>
            <TableHead>Files</TableHead>
            <TableHead className="text-right">Total Size</TableHead>
            <TableHead>Ran By</TableHead>
            <TableHead className="text-right">Created</TableHead>
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
