import {
  getMetadataField,
  MetadataFieldBadge,
} from "@/components/runs/metadata-badges";
import type { EpsonScannerFilterOptions } from "@/lib/api/instrument-runs";
import {
  COLOR_MODE_COLORS,
  DPI_COLORS,
  formatColorMode,
} from "@/lib/instrument-colors";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

// DPI is a numeric scalar; sort ascending so "300" < "600" rather than
// lexicographic order.
function sortDpiOptions(dpis: string[]): string[] {
  return [...dpis].sort((a, b) => Number(a) - Number(b));
}

function colorModeOption(value: string): { value: string; label: string } {
  return { value, label: formatColorMode(value) };
}

export function EpsonScannerRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: EpsonScannerFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "DPI",
        options: sortDpiOptions(filterOptions.dpis),
        paramKey: "dpi",
      },
      cell: (row) => {
        const dpi = getMetadataField(row.metadata, "dpi");
        return (
          <MetadataFieldBadge
            colorClass={dpi ? DPI_COLORS[dpi] : undefined}
            value={dpi}
          />
        );
      },
    },
    {
      filter: {
        label: "Color Mode",
        options: filterOptions.colorModes.map(colorModeOption),
        paramKey: "color_mode",
      },
      cell: (row) => {
        const colorMode = getMetadataField(row.metadata, "color_mode");
        return (
          <MetadataFieldBadge
            colorClass={colorMode ? COLOR_MODE_COLORS[colorMode] : undefined}
            value={colorMode ? formatColorMode(colorMode) : null}
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
