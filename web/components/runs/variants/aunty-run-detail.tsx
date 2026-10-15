import { AuntyPlateReport } from "@/components/runs/aunty/aunty-plate-report";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  AuntyRunBadges,
  hasAuntyMetadata,
} from "@/components/runs/run-metadata-badges";

export function AuntyRunDetail(props: RunDetailProps) {
  const { auntyPlate } = props;
  const metadata = props.run.metadata as Record<string, unknown>;

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasAuntyMetadata(metadata) ? (
          <AuntyRunBadges metadata={metadata} />
        ) : null
      }
    >
      <AuntyPlateReport
        curvesFileId={auntyPlate?.curvesFileId ?? null}
        plate={auntyPlate?.plate ?? { experiments: [] }}
      />
    </RunDetailLayout>
  );
}
