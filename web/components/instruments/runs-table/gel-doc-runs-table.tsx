import {
  getMetadataArray,
  getMetadataField,
  MetadataFieldBadge,
  sortWavelengths,
  TruncatedBadges,
} from "@/components/runs/metadata-badges";
import type { GelDocFilterOptions } from "@/lib/api/instrument-runs";
import {
  buildWavelengthColorMap,
  CAPTURE_TYPE_COLORS,
  CHANNEL_COLOR_STYLES,
  IMAGING_MODE_COLORS,
} from "@/lib/instrument-colors";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

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

  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "Capture Type",
        options: filterOptions.captureTypes,
        paramKey: "capture_type",
      },
      cell: (row) => {
        const captureType = getMetadataField(row.metadata, "capture_type");
        return (
          <MetadataFieldBadge
            colorClass={
              captureType ? CAPTURE_TYPE_COLORS[captureType] : undefined
            }
            value={captureType}
          />
        );
      },
    },
    {
      filter: {
        label: "Imaging Mode",
        options: filterOptions.imagingModes,
        paramKey: "imaging_mode",
      },
      cell: (row) => {
        const imagingMode = getMetadataField(row.metadata, "imaging_mode");
        return (
          <MetadataFieldBadge
            colorClass={
              imagingMode ? IMAGING_MODE_COLORS[imagingMode] : undefined
            }
            value={imagingMode}
          />
        );
      },
    },
    {
      filter: {
        label: "Wavelengths",
        options: sortWavelengths(filterOptions.wavelengths),
        paramKey: "gel_wavelength",
      },
      cell: (row) => (
        <TruncatedBadges
          colorMap={wavelengthColors}
          maxVisible={1}
          values={sortWavelengths(
            getMetadataArray(row.metadata, "wavelengths")
          )}
        />
      ),
    },
    {
      filter: {
        label: "Wavelength Colors",
        options: filterOptions.colors,
        paramKey: "gel_color",
      },
      cell: (row) => (
        <TruncatedBadges
          colorMap={CHANNEL_COLOR_STYLES}
          maxVisible={1}
          values={getMetadataArray(row.metadata, "colors")}
        />
      ),
    },
  ];

  return (
    <RunRowsTable
      columns={columns}
      data={data}
      instrumentId={instrumentId}
      ranByOptions={ranByOptions}
    />
  );
}
