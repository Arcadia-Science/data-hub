import {
  getMetadataArray,
  getMetadataField,
  MetadataFieldBadge,
  sortWavelengths,
  TruncatedBadges,
} from "@/components/runs/metadata-badges";
import type { PlateReaderFilterOptions } from "@/lib/api/instrument-runs";
import {
  buildWavelengthColorMap,
  MEASUREMENT_MODE_COLORS,
  MEASUREMENT_TYPE_COLORS,
} from "@/lib/instrument-colors";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

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

  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "Wavelengths",
        options: sortWavelengths(filterOptions.wavelengths),
        paramKey: "wavelength",
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
        label: "Measurement Mode",
        options: filterOptions.measurementModes,
        paramKey: "measurement_mode",
      },
      cell: (row) => {
        const mode = getMetadataField(row.metadata, "measurement_mode");
        return (
          <MetadataFieldBadge
            colorClass={mode ? MEASUREMENT_MODE_COLORS[mode] : undefined}
            value={mode}
          />
        );
      },
    },
    {
      filter: {
        label: "Measurement Type",
        options: filterOptions.measurementTypes,
        paramKey: "measurement_type",
      },
      cell: (row) => {
        const type = getMetadataField(row.metadata, "measurement_type");
        return (
          <MetadataFieldBadge
            colorClass={type ? MEASUREMENT_TYPE_COLORS[type] : undefined}
            value={type}
          />
        );
      },
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
