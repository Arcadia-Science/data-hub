import { RelativeTime } from "@/components/dashboard/relative-time";
import {
  getMetadataArray,
  getMetadataField,
  MetadataArrayBadges,
  MetadataFieldBadge,
} from "@/components/runs/metadata-badges";
import {
  formatAuntyExperimentType,
  formatAuntyRampRate,
  formatAuntyTemperatureRange,
} from "@/components/runs/run-metadata-badges";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuntyFilterOptions } from "@/lib/api/instrument-runs";
import { AUNTY_EXPERIMENT_TYPE_COLORS } from "@/lib/instrument-colors";
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";
import type { RunRow } from ".";
import { FilterableColumnHeader } from "./filterable-column-header";
import { RanByCell } from "./ran-by-cell";
import { RawFileColumnHeader } from "./raw-file-column-header";
import { RunIdLabel } from "./run-id-label";
import { RunRowActions } from "./run-row-actions";
import { RunSelectAllCheckbox, RunSelectCheckbox } from "./run-select-checkbox";
import type { RunRef } from "./run-selection-provider";
import { RunStatusIcon } from "./run-status-icon";

export function AuntyRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: AuntyFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const runRefs: RunRef[] = data.map(runRowToRef);
  const experimentColors: Record<string, string> = {};
  for (const option of filterOptions.experimentTypes) {
    const color = AUNTY_EXPERIMENT_TYPE_COLORS[option.value];
    if (color) {
      experimentColors[option.label] = color;
    }
  }

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
              label="Experiment"
              options={filterOptions.experimentTypes}
              paramKey="aunty_experiment_type"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Analysis mode"
              options={filterOptions.analysisModes}
              paramKey="aunty_analysis_mode"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Temperature"
              options={filterOptions.temperatures}
              paramKey="aunty_temperature"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ramp rate"
              options={filterOptions.rampRates}
              paramKey="aunty_ramp_rate"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              options={ranByOptions}
              paramKey="ran_by"
            />
          </TableHead>
          <TableHead className="text-right">Acquired</TableHead>
          <TableHead className="w-[108px]">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => {
          const isDeleted = row.deleted_at !== null;
          const experimentTypes = getMetadataArray(
            row.metadata,
            "experiment_type"
          );
          const analysisMode = getMetadataField(row.metadata, "analysis_mode");
          const startTemp = getMetadataField(row.metadata, "start_temp_c");
          const endTemp = getMetadataField(row.metadata, "end_temp_c");
          const rate = getMetadataField(row.metadata, "rate_c_per_min");
          const tempRange =
            startTemp && endTemp
              ? formatAuntyTemperatureRange(startTemp, endTemp)
              : null;
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
                <MetadataArrayBadges
                  colorMap={experimentColors}
                  values={experimentTypes.map(formatAuntyExperimentType)}
                />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge value={analysisMode} />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge value={tempRange} />
              </TableCell>
              <TableCell>
                <MetadataFieldBadge
                  value={rate ? formatAuntyRampRate(rate) : null}
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
