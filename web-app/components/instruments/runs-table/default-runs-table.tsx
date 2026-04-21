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
import { cn, formatBytes } from "@/lib/utils";

import type { RunsTableProps } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import { RanByCell } from "./ran-by-cell";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import type { RunRef } from "./run-selection-provider";
import { RunStatusIcon } from "./run-status-icon";

export function DefaultRunsTable({
  data,
  instrumentId,
  ranByOptions,
}: RunsTableProps) {
  const runRefs: RunRef[] = data.map((row) => ({
    id: row.id,
    instrumentId: row.instrument_id,
    runId: row.run_id,
  }));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <RunSelectAllCheckbox refs={runRefs} />
          </TableHead>
          <TableHead>Run ID</TableHead>
          <TableHead>Files</TableHead>
          <TableHead className="text-right">Total Size</TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran by"
              paramKey="ran_by"
              options={ranByOptions}
            />
          </TableHead>
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
                <RunSelectCheckbox
                  runRef={{
                    id: row.id,
                    instrumentId: row.instrument_id,
                    runId: row.run_id,
                  }}
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <RunStatusIcon
                    filesFailed={row.files_failed}
                    errorMessages={row.error_messages}
                  />
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
                <RelativeTime date={row.created_at.toISOString()} />
              </TableCell>
            </ClickableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
