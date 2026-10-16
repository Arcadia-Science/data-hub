import { QpcrMeltingReport } from "@/components/runs/qpcr/qpcr-melting-report";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
import {
  hasQpcrMetadata,
  QpcrRunBadges,
} from "@/components/runs/run-metadata-badges";
import { isQpcrMeltingArtifact } from "@/lib/runs/qpcr-melting";
import { isPdfFile } from "@/lib/runs/run-file-types";

export function QpcrRunDetail(props: RunDetailProps) {
  const { qpcrMeltingPlate, reportFiles, reportItems } = props;
  const metadata = props.run.metadata as Record<string, unknown>;
  const pdfCount = reportItems.pagination.total;
  // The plate grids own the melt artifacts, so the fallback list would
  // otherwise repeat them under a second heading.
  const otherReportFiles = reportFiles.filter(
    (file) => !(isPdfFile(file) || isQpcrMeltingArtifact(file.filename))
  );

  return (
    <RunDetailLayout
      {...props}
      badges={
        hasQpcrMetadata(metadata) ? <QpcrRunBadges metadata={metadata} /> : null
      }
    >
      {qpcrMeltingPlate != null && (
        <QpcrMeltingReport
          derivativesCsvFileId={qpcrMeltingPlate.derivativesCsvFileId}
          plate={qpcrMeltingPlate.plate}
        />
      )}
      {/* The plate grids lead, but the instrument's PDF export still holds the
          "Report Data" title every other variant uses. */}
      {pdfCount > 0 ? (
        <RunDetail.PdfCarousel initialPage={reportItems} />
      ) : (
        <RunDetail.Report files={otherReportFiles} />
      )}
    </RunDetailLayout>
  );
}
