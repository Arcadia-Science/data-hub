import type { ReactNode } from "react";
import { MetadataField } from "@/components/runs/run-metadata-badges";
import { RunTimestamps } from "@/components/runs/run-timestamps";
import { Separator } from "@/components/ui/separator";
import type { RunDetail } from "@/lib/api/instrument-runs";

export function RunMetadata({
  run,
  attributionsSlot,
  children,
}: {
  run: RunDetail;
  attributionsSlot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <div className="flex flex-wrap gap-x-8 gap-y-4 px-4 py-3">
        {children}
        <MetadataField label="Ran by">{attributionsSlot}</MetadataField>
      </div>
      <Separator />
      <RunTimestamps run={run} />
    </div>
  );
}
