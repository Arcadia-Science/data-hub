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
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import { RunStatusIcon } from "./run-status-icon";

function getMetadataField(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[key];
  return value != null ? String(value) : null;
}

const MEASUREMENT_TYPE_COLORS: Record<string, string> = {
  Kinetic:
    "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Endpoint:
    "border-teal-200 bg-teal-50 text-teal-600 dark:border-teal-700 dark:bg-teal-900 dark:text-teal-400",
  "Well Scan":
    "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300",
};

const MEASUREMENT_MODE_COLORS: Record<string, string> = {
  Absorbance:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
  Fluorescence:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
};

const WAVELENGTH_COLOR_CYCLE = [
  "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300",
  "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300",
  "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
];

function buildWavelengthColorMap(
  wavelengths: string[]
): Record<string, string> {
  const sorted = [...wavelengths].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const map: Record<string, string> = {};
  for (let i = 0; i < sorted.length; i++) {
    map[sorted[i]] = WAVELENGTH_COLOR_CYCLE[i % WAVELENGTH_COLOR_CYCLE.length];
  }
  return map;
}

function MetadataFieldBadge({
  value,
  colorClass,
}: {
  value: string | null;
  colorClass?: string;
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn("font-mono", colorClass)}>
      {value}
    </Badge>
  );
}

export function PlateReaderRunsTable({
  data,
  instrumentId,
  filterOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: PlateReaderFilterOptions;
}) {
  const wavelengthColors = buildWavelengthColorMap(filterOptions.wavelengths);

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
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
                    colorClass={
                      mode ? MEASUREMENT_MODE_COLORS[mode] : undefined
                    }
                  />
                </TableCell>
                <TableCell>
                  <MetadataFieldBadge
                    value={type}
                    colorClass={
                      type ? MEASUREMENT_TYPE_COLORS[type] : undefined
                    }
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
    </div>
  );
}
