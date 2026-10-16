import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  hasTapeStationMetadata,
  TapeStationRunBadges,
} from "@/components/runs/run-metadata-badges";
import { isPdfFile } from "@/lib/runs/run-file-types";

export function TapeStationRunDetail(props: RunDetailProps) {
  const { reportFiles, reportItems } = props;
  const metadata = props.run.metadata as Record<string, unknown>;
  const csvReportFiles = reportFiles.filter((f) => !isPdfFile(f));
  const pdfCount = reportItems.pagination.total;

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasTapeStationMetadata(metadata) ? (
          <TapeStationRunBadges metadata={metadata} />
        ) : null
      }
    >
      {pdfCount > 0 || csvReportFiles.length === 0 ? (
        <RunDetail.PdfCarousel initialPage={reportItems} />
      ) : null}
      {csvReportFiles.length > 0 && (
        <RunDetail.Report
          files={csvReportFiles}
          title={pdfCount > 0 ? "Peak tables" : undefined}
        />
      )}
    </RunDetailLayout>
  );
}
