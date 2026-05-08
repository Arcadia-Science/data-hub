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
import type { EpsonScannerFilterOptions } from "@/lib/api/instrument-runs";
import {
  COLOR_MODE_COLORS,
  COLOR_MODE_LABELS,
  DPI_COLORS,
} from "@/lib/instrument-colors";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { FilterableColumnHeader } from "./filterable-column-header";
import { MetadataFieldBadge, getMetadataField } from "./metadata-utils";
import { RanByCell } from "./ran-by-cell";
import { RawFileColumnHeader } from "./raw-file-column-header";
import { RunIdLabel } from "./run-id-label";
import { RunRowActions } from "./run-row-actions";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import type { RunRef } from "./run-selection-provider";
import { RunStatusIcon } from "./run-status-icon";

// DPI is a numeric scalar; sort ascending so "300" < "600" rather than
// lexicographic order.
function sortDpiOptions(dpis: string[]): string[] {
  return [...dpis].sort((a, b) => Number(a) - Number(b));
}

function colorModeOption(value: string): { value: string; label: string } {
  return { value, label: COLOR_MODE_LABELS[value] ?? value };
}

export function EpsonScannerRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: EpsonScannerFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const runRefs: RunRef[] = data.map(runRowToRef);
  const dpiOptions = sortDpiOptions(filterOptions.dpis);
  const colorModeOptions = filterOptions.colorModes.map(colorModeOption);

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
          <TableHead>
            <FilterableColumnHeader
              label="DPI"
              paramKey="dpi"
              options={dpiOptions}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Color Mode"
              paramKey="color_mode"
              options={colorModeOptions}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              paramKey="ran_by"
              options={ranByOptions}
            />
          </TableHead>
          <TableHead className="text-right">Created</TableHead>
          <TableHead className="w-[132px]">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => {
          const isDeleted = row.deleted_at !== null;
          const dpi = getMetadataField(row.metadata, "dpi");
          const colorMode = getMetadataField(row.metadata, "color_mode");
          return (
            <TableRow
              key={row.id}
              className={cn("group", isDeleted && "opacity-50")}
            >
              <TableCell>
                <RunSelectCheckbox runRef={runRowToRef(row)} />
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
                    href={`/instruments/${instrumentId}/runs/${encodeURIComponent(row.run_id)}`}
                    isDeleted={isDeleted}
                  />
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
                <MetadataFieldBadge
                  value={dpi}
                  colorClass={dpi ? DPI_COLORS[dpi] : undefined}
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  value={
                    colorMode
                      ? (COLOR_MODE_LABELS[colorMode] ?? colorMode)
                      : null
                  }
                  colorClass={
                    colorMode ? COLOR_MODE_COLORS[colorMode] : undefined
                  }
                />
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
              <TableCell className="py-1">
                <RunRowActions row={row} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
