import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  HinaRunBadges,
  hasHinaMetadata,
} from "@/components/runs/run-metadata-badges";

export function HinaMicroscopeRunDetail({
  run,
  files,
  filesPagination,
  fileStats,
  reportImages,
  instrumentId,
  runId,
  attributionsSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;

  return (
    <>
      <RunDetail.Header attributionsSlot={attributionsSlot} run={run}>
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
        {hasHinaMetadata(run.metadata as Record<string, unknown>) && (
          <RunDetail.Metadata>
            <HinaRunBadges metadata={run.metadata as Record<string, unknown>} />
          </RunDetail.Metadata>
        )}
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
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
