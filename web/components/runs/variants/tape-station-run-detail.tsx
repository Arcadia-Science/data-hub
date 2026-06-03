import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  hasTapeStationMetadata,
  TapeStationRunBadges,
} from "@/components/runs/run-metadata-badges";

export function TapeStationRunDetail({
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
        {hasTapeStationMetadata(run.metadata as Record<string, unknown>) && (
          <RunDetail.Metadata>
            <TapeStationRunBadges
              metadata={run.metadata as Record<string, unknown>}
            />
          </RunDetail.Metadata>
        )}
        <RunDetail.Files
          files={files}
          pagination={filesPagination}
          stats={fileStats}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
      </RunDetail.FilesMetadataLayout>

      <RunDetail.Report files={reportFiles} />
    </>
  );
}
