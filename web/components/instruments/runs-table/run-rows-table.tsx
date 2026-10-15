import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import {
  FilterableColumnHeader,
  type FilterOption,
  type InstrumentFilterParamKey,
} from "./filterable-column-header";
import { RanByCell } from "./ran-by-cell";
import { RawFileColumnHeader } from "./raw-file-column-header";
import { RunIdCell } from "./run-id-cell";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import { RunTimeCells, RunTimeHeads } from "./run-time-columns";

/**
 * A column of instrument metadata, such as "Wavelengths" or "DPI". Its header
 * is a filter menu bound to a URL param, and its cell shows that row's value.
 */
export interface MetadataColumn {
  cell: (row: RunRow) => ReactNode;
  filter: {
    label: string;
    options: FilterOption[];
    paramKey: InstrumentFilterParamKey;
  };
}

/**
 * The runs table every instrument shares: a checkbox, the run ID, file count
 * and size, then the instrument's own metadata columns, then who ran it and
 * when. An instrument's table passes only its metadata columns, so a new
 * shared column or a fix to row selection happens here once.
 */
export function RunRowsTable({
  columns = [],
  data,
  instrumentId,
  ranByOptions,
}: {
  columns?: MetadataColumn[];
  data: RunRow[];
  instrumentId: string;
  ranByOptions: { value: string; label: string }[];
}) {
  const runRefs = data.map(runRowToRef);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <RunSelectAllCheckbox refs={runRefs} />
          </TableHead>
          <TableHead>Run ID</TableHead>
          <TableHead>
            <RawFileColumnHeader label="Files" />
          </TableHead>
          <TableHead className="text-right">
            <RawFileColumnHeader label="Size" />
          </TableHead>
          {columns.map((column) => (
            <TableHead key={column.filter.paramKey}>
              <FilterableColumnHeader {...column.filter} />
            </TableHead>
          ))}
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              options={ranByOptions}
              paramKey="ran_by"
            />
          </TableHead>
          <RunTimeHeads />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => {
          const isDeleted = row.deleted_at !== null;
          return (
            <TableRow className={cn(isDeleted && "opacity-50")} key={row.id}>
              <TableCell>
                <RunSelectCheckbox runRef={runRowToRef(row)} />
              </TableCell>
              <TableCell>
                <RunIdCell
                  href={`/instruments/${instrumentId}/runs/${encodeURIComponent(row.run_id)}`}
                  run={row}
                />
              </TableCell>
              <TableCell className="text-sm tabular-nums">
                {row.file_count}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {formatBytes(row.total_size_bytes)}
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.filter.paramKey}>
                  {column.cell(row)}
                </TableCell>
              ))}
              <TableCell>
                <RanByCell
                  attributions={row.attributions}
                  instrumentId={row.instrument_id}
                  runId={row.run_id}
                />
              </TableCell>
              <RunTimeCells row={row} />
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
