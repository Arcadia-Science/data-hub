import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { HinaReportSection } from "@/components/runs/hina-report-section";
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
  instrumentId,
  runId,
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
        {hasHinaMetadata(run.metadata as Record<string, unknown>) && (
          <RunDetail.Metadata>
            <HinaRunBadges metadata={run.metadata as Record<string, unknown>} />
          </RunDetail.Metadata>
        )}
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
      </RunDetail.FilesMetadataLayout>

      <HinaReportSection files={files} />

      <RunDetail.Analysis />
    </>
  );
}
