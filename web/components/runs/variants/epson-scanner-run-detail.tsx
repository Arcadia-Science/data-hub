import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  EpsonScannerRunBadges,
  hasEpsonScannerMetadata,
} from "@/components/runs/run-metadata-badges";

export function EpsonScannerRunDetail({
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

  return (
    <>
      <RunDetail.Header run={run}>
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
        <RunDetail.Metadata attributionsSlot={attributionsSlot} run={run}>
          {hasEpsonScannerMetadata(run.metadata as Record<string, unknown>) && (
            <EpsonScannerRunBadges
              metadata={run.metadata as Record<string, unknown>}
            />
          )}
        </RunDetail.Metadata>
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          isDeleted={isDeleted}
          pagination={filesPagination}
          runId={runId}
          stats={fileStats}
        />
      </RunDetail.FilesMetadataLayout>

      <RunDetail.Report files={reportFiles} />
    </>
  );
}
