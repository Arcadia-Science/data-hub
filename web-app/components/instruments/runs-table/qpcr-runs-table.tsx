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
import type { QpcrFilterOptions } from "@/lib/api/instrument-runs";
import { getDyeChannelColor } from "@/lib/instrument-colors";
import { cn, formatBytes } from "@/lib/utils";

import type { RunRow } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import { MetadataArrayBadges, getMetadataArray } from "./metadata-utils";
import { RunStatusIcon } from "./run-status-icon";

export function QpcrRunsTable({
  data,
  instrumentId,
  filterOptions,
}: {
  data: RunRow[];
  instrumentId: string;
  filterOptions: QpcrFilterOptions;
}) {
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
                label="Dye Channels"
                paramKey="dye_channel"
                options={filterOptions.dyeChannels}
              />
            </TableHead>
            <TableHead className="text-right">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const isDeleted = row.deleted_at !== null;
            const dyeChannels = getMetadataArray(row.metadata, "dye_channels");
            const dyeChannelColors = Object.fromEntries(
              dyeChannels.map((ch) => [ch, getDyeChannelColor(ch)])
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
                  <MetadataArrayBadges
                    values={dyeChannels}
                    colorMap={dyeChannelColors}
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
