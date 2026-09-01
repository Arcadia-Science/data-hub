import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { QpcrMeltingReport } from "@/components/runs/qpcr/qpcr-melting-report";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  hasQpcrMetadata,
  QpcrRunBadges,
} from "@/components/runs/run-metadata-badges";
import { isQpcrMeltingArtifact } from "@/lib/runs/qpcr-melting";
import { isPdfFile } from "@/lib/runs/run-file-types";

export function QpcrRunDetail({
  run,
  files,
  filesDownloadableCount,
  filesPagination,
  fileStats,
  reportFiles,
  reportItems,
  qpcrMeltingPlate,
  instrumentId,
  runId,
  attributionsSlot,
  runNavSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;
  const pdfCount = reportItems.pagination.total;
  // The plate grids own the melt artifacts, so the fallback list would
  // otherwise repeat them under a second heading.
  const otherReportFiles = reportFiles.filter(
    (file) => !(isPdfFile(file) || isQpcrMeltingArtifact(file.filename))
  );

  return (
    <>
      <RunDetail.Header run={run} runNavSlot={runNavSlot}>
        {!isDeleted && (
          <DeleteRunDialog
            fileCount={activeFileCount}
            hasProcessedFiles={hasProcessedFiles}
            instrumentId={instrumentId}
            runId={runId}
          />
        )}
        {isDeleted && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Metadata
          attributionsSlot={attributionsSlot}
          fileStats={fileStats}
          run={run}
        >
          {hasQpcrMetadata(run.metadata as Record<string, unknown>) && (
            <QpcrRunBadges metadata={run.metadata as Record<string, unknown>} />
          )}
        </RunDetail.Metadata>
        <RunDetail.Files
          files={files}
          filteredDownloadableCount={filesDownloadableCount}
          instrumentId={instrumentId}
          instrumentType={run.instrumentType}
          isDeleted={isDeleted}
          pagination={filesPagination}
          runId={runId}
          stats={fileStats}
        />
      </RunDetail.FilesMetadataLayout>

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
    </>
  );
}
