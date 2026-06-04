import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RamanReportSection } from "@/components/runs/raman-report-section";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";

export function InstantRamanRunDetail({
  run,
  files,
  filesPagination,
  fileStats,
  reportFiles,
  instrumentId,
  runId,
  attributionsSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;

  // Within an InstantRaman run we treat every active CSV as a Raman spectrum.
  // Non-conforming files surface an inline error in the chart area rather than
  // being silently filtered out, so users always see what's available. Sourced
  // from the report-files set (which includes every active CSV) so the full
  // spectrum list survives server-side pagination of the files table.
  const spectra = reportFiles
    .filter((f) => f.deletedAt === null && /\.csv$/i.test(f.filename))
    .map((f) => ({ fileId: f.id, filename: f.filename }))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  return (
    <>
      <RunDetail.Header run={run} attributionsSlot={attributionsSlot}>
        {!isDeleted && (
          <DeleteRunDialog
            instrumentId={instrumentId}
            runId={runId}
            fileCount={activeFileCount}
            hasProcessedFiles={hasProcessedFiles}
          />
        )}
        {isDeleted && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Files
          files={files}
          pagination={filesPagination}
          stats={fileStats}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
      </RunDetail.FilesMetadataLayout>

      <RamanReportSection spectra={spectra} />
    </>
  );
}
