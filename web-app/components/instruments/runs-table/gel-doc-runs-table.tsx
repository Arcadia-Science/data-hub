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
import { RunStatusIcon } from "./run-status-icon";

const CAPTURE_TYPE_COLORS: Record<string, string> = {
  Gel: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Blot: "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950 dark:text-purple-300",
  Plate:
    "border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-300",
  Colony:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
};

const IMAGING_MODE_COLORS: Record<string, string> = {
  Fluorescence:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  Chemiluminescence:
    "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-300",
  Colorimetric:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "UV Transillumination":
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
  "White Epi":
    "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300",
};

const CHANNEL_COLOR_STYLES: Record<string, string> = {
  Red: "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300",
  Green:
    "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300",
  Blue: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Cyan: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
  Magenta:
    "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  Yellow:
    "border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  Orange:
    "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300",
  "Far Red":
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
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

function buildWavelengthColorMap(data: RunRow[]): Record<string, string> {
  const set = new Set<string>();
  for (const row of data) {
    for (const v of getMetadataArray(row.metadata, "wavelengths")) {
      set.add(v);
    }
  }
  const sorted = [...set].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const map: Record<string, string> = {};
  for (let i = 0; i < sorted.length; i++) {
    map[sorted[i]] = WAVELENGTH_COLOR_CYCLE[i % WAVELENGTH_COLOR_CYCLE.length];
  }
  return map;
}

export function GelDocRunsTable({
  data,
  instrumentId,
  filterOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: GelDocFilterOptions;
}) {
  const wavelengthColors = buildWavelengthColorMap(data);

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
