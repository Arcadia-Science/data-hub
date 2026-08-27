import { RelativeTime } from "@/components/dashboard/relative-time";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { HinaFilterOptions } from "@/lib/api/instrument-runs";
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
  const runRefs: RunRef[] = data.map(runRowToRef);

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
              label="Channels"
              options={filterOptions.channels}
              paramKey="hina_channel"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Dimensions"
              options={filterOptions.dimensions}
              paramKey="hina_dimension"
            />
          </TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Sizes"
              options={filterOptions.sizes}
              paramKey="hina_size"
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
          const channels = extractHinaChannels(row.metadata);
          const dimensions = getMetadataArray(row.metadata, "dimensions");
          const sizes = getMetadataRecord(row.metadata, "sizes");
          const sizesLabel = sizes ? formatHinaSizes(sizes) : "";
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
                  <RunStatusIcon run={row} />
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
                <HinaChannelBadges channels={channels} maxVisible={1} />
              </TableCell>
              <TableCell>
                <MetadataArrayBadges values={dimensions} />
              </TableCell>
              <TableCell>
                {sizesLabel ? (
                  <Badge className="font-mono" variant="outline">
                    {sizesLabel}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">&mdash;</span>
                )}
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
