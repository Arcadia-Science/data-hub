import {
  getMetadataArray,
  getMetadataField,
  MetadataArrayBadges,
  MetadataFieldBadge,
} from "@/components/runs/metadata-badges";
import {
  formatAuntyExperimentType,
  formatAuntyRampRate,
  formatAuntyTemperatureDisplay,
} from "@/components/runs/run-metadata-badges";
import type { AuntyFilterOptions } from "@/lib/api/instrument-runs";
import { AUNTY_EXPERIMENT_TYPE_COLORS } from "@/lib/instrument-colors";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

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
  const experimentColors: Record<string, string> = {};
  for (const option of filterOptions.experimentTypes) {
    const color = AUNTY_EXPERIMENT_TYPE_COLORS[option.value];
    if (color) {
      experimentColors[option.label] = color;
    }
  }

  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "Experiment",
        options: filterOptions.experimentTypes,
        paramKey: "aunty_experiment_type",
      },
      cell: (row) => (
        <MetadataArrayBadges
          colorMap={experimentColors}
          values={getMetadataArray(row.metadata, "experiment_type").map(
            formatAuntyExperimentType
          )}
        />
      ),
    },
    {
      filter: {
        label: "Analysis mode",
        options: filterOptions.analysisModes,
        paramKey: "aunty_analysis_mode",
      },
      cell: (row) => (
        <MetadataFieldBadge
          value={getMetadataField(row.metadata, "analysis_mode")}
        />
      ),
    },
    {
      filter: {
        label: "Temperature",
        options: filterOptions.temperatures,
        paramKey: "aunty_temperature",
      },
      cell: (row) => (
        <MetadataFieldBadge
          value={formatAuntyTemperatureDisplay(
            (row.metadata ?? {}) as Record<string, unknown>
          )}
        />
      ),
    },
    {
      filter: {
        label: "Ramp rate",
        options: filterOptions.rampRates,
        paramKey: "aunty_ramp_rate",
      },
      cell: (row) => {
        const rate = getMetadataField(row.metadata, "rate_c_per_min");
        return (
          <MetadataFieldBadge value={rate ? formatAuntyRampRate(rate) : null} />
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
