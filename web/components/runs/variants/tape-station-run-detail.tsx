import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  hasTapeStationMetadata,
  TapeStationRunBadges,
} from "@/components/runs/run-metadata-badges";
import { isPdfFile } from "@/lib/runs/run-file-types";

export function TapeStationRunDetail({
  run,
  files,
  filesDownloadableCount,
  filesPagination,
  fileStats,
  reportFiles,
  reportItems,
  instrumentId,
  runId,
  attributionsSlot,
  runNavSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;
  const csvReportFiles = reportFiles.filter((f) => !isPdfFile(f));
  const pdfCount = reportItems.pagination.total;

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
          {hasTapeStationMetadata(run.metadata as Record<string, unknown>) && (
            <TapeStationRunBadges
              metadata={run.metadata as Record<string, unknown>}
            />
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

      {pdfCount > 0 || csvReportFiles.length === 0 ? (
        <RunDetail.PdfCarousel initialPage={reportItems} />
      ) : null}
      {csvReportFiles.length > 0 && (
        <RunDetail.Report
          files={csvReportFiles}
          title={pdfCount > 0 ? "Peak tables" : undefined}
        />
      )}
    </>
  );
}
