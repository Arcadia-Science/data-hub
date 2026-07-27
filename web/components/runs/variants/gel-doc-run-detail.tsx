import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  GelDocRunBadges,
  hasGelDocMetadata,
} from "@/components/runs/run-metadata-badges";

export function GelDocRunDetail({
  run,
  files,
  filesDownloadableCount,
  filesPagination,
  fileStats,
  reportImages,
  instrumentId,
  runId,
  attributionsSlot,
  runNavSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;

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
        <RunDetail.Metadata attributionsSlot={attributionsSlot} run={run}>
          {hasGelDocMetadata(run.metadata as Record<string, unknown>) && (
            <GelDocRunBadges
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

      <RunDetail.ImageCarousel files={reportImages} />
    </>
  );
}
