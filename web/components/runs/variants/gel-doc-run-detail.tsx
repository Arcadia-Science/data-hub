import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  GelDocRunBadges,
  hasGelDocMetadata,
} from "@/components/runs/run-metadata-badges";

export function GelDocRunDetail(props: RunDetailProps) {
  const metadata = props.run.metadata as Record<string, unknown>;

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasGelDocMetadata(metadata) ? (
          <GelDocRunBadges metadata={metadata} />
        ) : null
      }
    >
      <RunDetail.ImageCarousel initialPage={props.reportItems} />
    </RunDetailLayout>
  );
}
