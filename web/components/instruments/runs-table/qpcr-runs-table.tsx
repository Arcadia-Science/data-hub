import {
  getMetadataArray,
  MetadataArrayBadges,
} from "@/components/runs/metadata-badges";
import type { QpcrFilterOptions } from "@/lib/api/instrument-runs";
import { getDyeChannelColor } from "@/lib/instrument-colors";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

export function QpcrRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: QpcrFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "Dye Channels",
        options: filterOptions.dyeChannels,
        paramKey: "dye_channel",
      },
      cell: (row) => {
        const dyeChannels = getMetadataArray(row.metadata, "dye_channels");
        const dyeChannelColors = Object.fromEntries(
          dyeChannels.map((ch) => [ch, getDyeChannelColor(ch)])
        );
        return (
          <MetadataArrayBadges
            colorMap={dyeChannelColors}
            values={dyeChannels}
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
