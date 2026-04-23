import { RelativeTime } from "@/components/dashboard/relative-time";
import {
  extractHinaChannels,
  formatHinaSizes,
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
import { runRowToRef } from "@/lib/runs/row-actions";
import { cn, formatBytes } from "@/lib/utils";

import type { RunsTableProps } from ".";
import { ClickableRow } from "./clickable-row";
import { FilterableColumnHeader } from "./filterable-column-header";
import {
  MetadataArrayBadges,
  getMetadataArray,
  getMetadataRecord,
} from "./metadata-utils";
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
  ranByOptions,
}: RunsTableProps) {
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
          <TableHead>Channels</TableHead>
          <TableHead>Dimensions</TableHead>
          <TableHead>Sizes</TableHead>
          <TableHead>
            <FilterableColumnHeader
              label="Ran By"
              paramKey="ran_by"
              options={ranByOptions}
            />
          </TableHead>
          <TableHead className="text-right">Created</TableHead>
          <TableHead className="w-[132px]">
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
            <ClickableRow
              key={row.id}
              href={`/instruments/${instrumentId}/runs/${encodeURIComponent(row.run_id)}`}
              className={cn(isDeleted && "opacity-50")}
            >
              <TableCell>
                <RunSelectCheckbox runRef={runRowToRef(row)} />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <RunStatusIcon
                    fileCount={row.file_count}
                    filesCompleted={row.files_completed}
                    filesFailed={row.files_failed}
                    filesPendingUpload={row.files_pending_upload}
                    filesUploaded={row.files_uploaded}
                    filesProcessing={row.files_processing}
                    errorMessages={row.error_messages}
                  />
                  <RunIdLabel runId={row.run_id} isDeleted={isDeleted} />
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
                {channels.length === 0 ? (
                  <span className="text-muted-foreground">&mdash;</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {channels.map((c) => {
                      const style = c.color
                        ? { borderColor: c.color, color: c.color }
                        : undefined;
                      return (
                        <Badge
                          key={c.name}
                          variant="outline"
                          className="font-mono"
                          style={style}
                        >
                          {c.color && (
                            <span
                              aria-hidden="true"
                              className="inline-block size-2 rounded-full"
                              style={{ backgroundColor: c.color }}
                            />
                          )}
                          {c.name}
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <MetadataArrayBadges values={dimensions} />
              </TableCell>
              <TableCell>
                {sizesLabel ? (
                  <Badge variant="outline" className="font-mono">
                    {sizesLabel}
                  </Badge>
                ) : (
                  <span className="text-muted-foreground">&mdash;</span>
                )}
              </TableCell>
              <TableCell>
                <RanByCell
                  instrumentId={row.instrument_id}
                  runId={row.run_id}
                  attributions={row.attributions}
                />
              </TableCell>
              <TableCell className="text-right">
                <RelativeTime date={row.created_at.toISOString()} />
              </TableCell>
              <TableCell className="py-1">
                <RunRowActions row={row} />
              </TableCell>
            </ClickableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
