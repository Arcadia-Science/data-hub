import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  EpsonScannerRunBadges,
  hasEpsonScannerMetadata,
} from "@/components/runs/run-metadata-badges";

export function EpsonScannerRunDetail(props: RunDetailProps) {
  const metadata = props.run.metadata as Record<string, unknown>;

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasEpsonScannerMetadata(metadata) ? (
          <EpsonScannerRunBadges metadata={metadata} />
        ) : null
      }
    >
      <RunDetail.Report files={props.reportFiles} />
    </RunDetailLayout>
  );
}
