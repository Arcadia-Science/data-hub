import {
  getMetadataArray,
  getMetadataRecord,
  MetadataArrayBadges,
} from "@/components/runs/metadata-badges";
import {
  extractHinaChannels,
  formatHinaSizes,
  HinaChannelBadges,
} from "@/components/runs/run-metadata-badges";
import { Badge } from "@/components/ui/badge";
import type { HinaFilterOptions } from "@/lib/api/instrument-runs";
import type { RunRow } from ".";
import { type MetadataColumn, RunRowsTable } from "./run-rows-table";

export function HinaRunsTable({
  data,
  instrumentId,
  filterOptions,
  ranByOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: HinaFilterOptions;
  ranByOptions: { value: string; label: string }[];
}) {
  const columns: MetadataColumn[] = [
    {
      filter: {
        label: "Channels",
        options: filterOptions.channels,
        paramKey: "hina_channel",
      },
      cell: (row) => (
        <HinaChannelBadges
          channels={extractHinaChannels(row.metadata)}
          maxVisible={1}
        />
      ),
    },
    {
      filter: {
        label: "Dimensions",
        options: filterOptions.dimensions,
        paramKey: "hina_dimension",
      },
      cell: (row) => (
        <MetadataArrayBadges
          values={getMetadataArray(row.metadata, "dimensions")}
        />
      ),
    },
    {
      filter: {
        label: "Sizes",
        options: filterOptions.sizes,
        paramKey: "hina_size",
      },
      cell: (row) => {
        const sizes = getMetadataRecord(row.metadata, "sizes");
        const sizesLabel = sizes ? formatHinaSizes(sizes) : "";
        return sizesLabel ? (
          <Badge className="font-mono" variant="outline">
            {sizesLabel}
          </Badge>
        ) : (
          <span className="text-muted-foreground">&mdash;</span>
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
