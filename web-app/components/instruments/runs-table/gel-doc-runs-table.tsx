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
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import {
  MetadataArrayBadges,
  MetadataFieldBadge,
  getMetadataArray,
  getMetadataField,
} from "./metadata-utils";
import { RanByCell } from "./ran-by-cell";
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
              options={filterOptions.wavelengths}
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
          <TableHead className="text-right">Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => {
          const isDeleted = row.deleted_at !== null;
          const captureType = getMetadataField(row.metadata, "capture_type");
          const imagingMode = getMetadataField(row.metadata, "imaging_mode");
          const wavelengths = getMetadataArray(row.metadata, "wavelengths");
          const wavelengthColorLabels = getMetadataArray(
            row.metadata,
            "colors"
          );
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
                <MetadataArrayBadges
                  values={wavelengths}
                  colorMap={wavelengthColors}
                />
              </TableCell>
              <TableCell>
                <MetadataArrayBadges
                  values={wavelengthColorLabels}
                  colorMap={CHANNEL_COLOR_STYLES}
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
