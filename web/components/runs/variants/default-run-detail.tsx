import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  DefaultRunBadges,
  hasDefaultMetadata,
} from "@/components/runs/run-metadata-badges";

export function DefaultRunDetail(props: RunDetailProps) {
  const metadata = props.run.metadata as Record<string, unknown>;

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasDefaultMetadata(metadata) ? (
          <DefaultRunBadges metadata={metadata} />
        ) : null
      }
    >
      <RunDetail.Report files={props.reportFiles} />
    </RunDetailLayout>
  );
}
