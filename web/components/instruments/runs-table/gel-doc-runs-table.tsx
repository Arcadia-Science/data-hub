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
import type { GelDocFilterOptions } from "@/lib/api/instrument-runs";
import {
  CAPTURE_TYPE_COLORS,
  CHANNEL_COLOR_STYLES,
  IMAGING_MODE_COLORS,
  buildWavelengthColorMap,
} from "@/lib/instrument-colors";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { AcquiredColumnHeader } from "./acquired-column-header";
import { FilterableColumnHeader } from "./filterable-column-header";
import {
  MetadataFieldBadge,
  TruncatedBadges,
  getMetadataArray,
  getMetadataField,
  sortWavelengths,
} from "./metadata-utils";
import { RanByCell } from "./ran-by-cell";
import { RawFileColumnHeader } from "./raw-file-column-header";
import { RunIdLabel } from "./run-id-label";
import { RunRowActions } from "./run-row-actions";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import type { RunRef } from "./run-selection-provider";
import { RunStatusIcon } from "./run-status-icon";

export function GelDocRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: GelDocFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const allWavelengths = data.flatMap((row) =>
    getMetadataArray(row.metadata, "wavelengths")
  );
  const wavelengthColors = buildWavelengthColorMap(allWavelengths);
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
              label="Capture Type"
              paramKey="capture_type"
              options={filterOptions.captureTypes}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Imaging Mode"
              paramKey="imaging_mode"
              options={filterOptions.imagingModes}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Wavelengths"
              paramKey="gel_wavelength"
              options={sortedWavelengthOptions}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Wavelength Colors"
              paramKey="gel_color"
              options={filterOptions.colors}
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              paramKey="ran_by"
              options={ranByOptions}
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
          const captureType = getMetadataField(row.metadata, "capture_type");
          const imagingMode = getMetadataField(row.metadata, "imaging_mode");
          const wavelengths = sortWavelengths(
            getMetadataArray(row.metadata, "wavelengths")
          );
          const wavelengthColorLabels = getMetadataArray(
            row.metadata,
            "colors"
          );
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
                  value={captureType}
                  colorClass={
                    captureType ? CAPTURE_TYPE_COLORS[captureType] : undefined
                  }
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  value={imagingMode}
                  colorClass={
                    imagingMode ? IMAGING_MODE_COLORS[imagingMode] : undefined
                  }
                />
              </TableCell>
              <TableCell>
                <TruncatedBadges
                  values={wavelengths}
                  colorMap={wavelengthColors}
                  maxVisible={1}
                />
              </TableCell>
              <TableCell>
                <TruncatedBadges
                  values={wavelengthColorLabels}
                  colorMap={CHANNEL_COLOR_STYLES}
                  maxVisible={1}
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
