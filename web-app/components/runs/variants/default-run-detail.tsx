import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  DefaultRunBadges,
  hasDefaultMetadata,
} from "@/components/runs/run-metadata-badges";

export function DefaultRunDetail({
  run,
  files,
  instrumentId,
  runId,
  isWatcherOnline,
  attributionsSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const canRestore = isDeleted && run.filesPurgedAt === null;
  const activeFileCount = files.filter((f) => f.deletedAt === null).length;
  const hasProcessedFiles =
    files.filter((f) => f.category === "processed" && f.deletedAt === null)
      .length > 0;

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
        {canRestore && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        {hasDefaultMetadata(run.metadata as Record<string, unknown>) && (
          <RunDetail.Metadata>
            <DefaultRunBadges
              metadata={run.metadata as Record<string, unknown>}
            />
          </RunDetail.Metadata>
        )}
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
          isWatcherOnline={isWatcherOnline}
        />
      </RunDetail.FilesMetadataLayout>

      <RunDetail.Report files={files} />

      <RunDetail.Analysis />
    </>
  );
}
