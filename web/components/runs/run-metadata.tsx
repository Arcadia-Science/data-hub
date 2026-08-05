import type { ReactNode } from "react";
import { RawFileColumnHeader } from "@/components/instruments/runs-table/raw-file-column-header";
import { MetadataField } from "@/components/runs/run-metadata-badges";
import { RunTimestamps } from "@/components/runs/run-timestamps";
import { Separator } from "@/components/ui/separator";
import type { RunDetail, RunFileStats } from "@/lib/api/instrument-runs";
import { formatBytes } from "@/lib/utils";

function RawFileMetadataLabel({ label }: { label: string }) {
  return (
    <RawFileColumnHeader
      className="h-auto font-normal text-muted-foreground text-sm"
      label={label}
    />
  );
}

export function RunMetadata({
  run,
  fileStats,
  attributionsSlot,
  children,
}: {
  run: RunDetail;
  // Raw-only count/size — same aggregates as the runs-table Files/Size columns.
  fileStats: RunFileStats;
  attributionsSlot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <div className="flex flex-wrap gap-x-8 gap-y-4 px-4 py-3">
        <MetadataField label={<RawFileMetadataLabel label="Files" />}>
          <span className="text-sm tabular-nums">{fileStats.rawActive}</span>
        </MetadataField>
        <MetadataField label={<RawFileMetadataLabel label="Size" />}>
          <span className="text-sm tabular-nums">
            {formatBytes(fileStats.rawTotalSizeBytes)}
          </span>
        </MetadataField>
        <MetadataField label="Ran By">{attributionsSlot}</MetadataField>
        {children}
      </div>
      <Separator />
      <RunTimestamps run={run} />
    </div>
  );
}
