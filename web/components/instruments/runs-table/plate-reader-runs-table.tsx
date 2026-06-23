import { RelativeTime } from "@/components/dashboard/relative-time";
import {
  getMetadataArray,
  getMetadataField,
  MetadataFieldBadge,
  sortWavelengths,
  TruncatedBadges,
} from "@/components/runs/metadata-badges";
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
  buildWavelengthColorMap,
  MEASUREMENT_MODE_COLORS,
  MEASUREMENT_TYPE_COLORS,
} from "@/lib/instrument-colors";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";
import type { RunRow } from ".";
import { AcquiredColumnHeader } from "./acquired-column-header";
import { FilterableColumnHeader } from "./filterable-column-header";
import { RanByCell } from "./ran-by-cell";
import { RawFileColumnHeader } from "./raw-file-column-header";
import { RunIdLabel } from "./run-id-label";
import { RunRowActions } from "./run-row-actions";
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
  const sortedWavelengthOptions = sortWavelengths(filterOptions.wavelengths);
  const runRefs: RunRef[] = data.map(runRowToRef);

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
              label="Wavelengths"
              options={sortedWavelengthOptions}
              paramKey="wavelength"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Measurement Mode"
              options={filterOptions.measurementModes}
              paramKey="measurement_mode"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Measurement Type"
              options={filterOptions.measurementTypes}
              paramKey="measurement_type"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              options={ranByOptions}
              paramKey="ran_by"
            />
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
          const wavelengths = sortWavelengths(
            getMetadataArray(row.metadata, "wavelengths")
          );
          const mode = getMetadataField(row.metadata, "measurement_mode");
          const type = getMetadataField(row.metadata, "measurement_type");
          return (
            <TableRow
              className={cn("group", isDeleted && "opacity-50")}
              key={row.id}
            >
              <TableCell>
                <RunSelectCheckbox runRef={runRowToRef(row)} />
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
                    href={`/instruments/${instrumentId}/runs/${encodeURIComponent(row.run_id)}`}
                    isDeleted={isDeleted}
                    runId={row.run_id}
                  />
                  {isDeleted && (
                    <Badge className="ml-1.5 font-normal" variant="outline">
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
                <TruncatedBadges
                  colorMap={wavelengthColors}
                  maxVisible={1}
                  values={wavelengths}
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  colorClass={mode ? MEASUREMENT_MODE_COLORS[mode] : undefined}
                  value={mode}
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  colorClass={type ? MEASUREMENT_TYPE_COLORS[type] : undefined}
                  value={type}
                />
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
                  date={(row.acquired_at ?? row.created_at).toISOString()}
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
  );
}
