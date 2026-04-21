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
import type { PlateReaderFilterOptions } from "@/lib/api/instrument-runs";
import {
  MEASUREMENT_MODE_COLORS,
  MEASUREMENT_TYPE_COLORS,
  buildWavelengthColorMap,
} from "@/lib/instrument-colors";
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import { MetadataFieldBadge, getMetadataField } from "./metadata-utils";
import { RanByCell } from "./ran-by-cell";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import type { RunRef } from "./run-selection-provider";
import { RunStatusIcon } from "./run-status-icon";

export function PlateReaderRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: PlateReaderFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const wavelengthColors = buildWavelengthColorMap(filterOptions.wavelengths);
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
              label="Wavelength"
              paramKey="wavelength"
              options={filterOptions.wavelengths}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Measurement Mode"
              paramKey="measurement_mode"
              options={filterOptions.measurementModes}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Measurement Type"
              paramKey="measurement_type"
              options={filterOptions.measurementTypes}
            />
          </TableHead>
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
          const wavelength = getMetadataField(row.metadata, "wavelength");
          const mode = getMetadataField(row.metadata, "measurement_mode");
          const type = getMetadataField(row.metadata, "measurement_type");
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
                <MetadataFieldBadge
                  value={wavelength}
                  colorClass={
                    wavelength ? wavelengthColors[wavelength] : undefined
                  }
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  value={mode}
                  colorClass={mode ? MEASUREMENT_MODE_COLORS[mode] : undefined}
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  value={type}
                  colorClass={type ? MEASUREMENT_TYPE_COLORS[type] : undefined}
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
            </ClickableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
