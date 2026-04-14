import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";

export function DefaultRunDetail({
  run,
  files,
  reportData,
  instrumentId,
  runId,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const canRestore = isDeleted && run.filesPurgedAt === null;
  const activeFileCount = files.filter((f) => f.deletedAt === null).length;
  const hasReportData = reportData.length > 0;

  const analysisData = reportData.filter((r) => r.fileId === null);
  const fileReportData = reportData.filter((r) => r.fileId !== null);

  return (
    <>
      <RunDetail.Header run={run}>
        {!isDeleted && (
          <DeleteRunDialog
            instrumentId={instrumentId}
            runId={runId}
            fileCount={activeFileCount}
            hasReportData={hasReportData}
          />
        )}
        {canRestore && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
        <RunDetail.Metadata
          metadata={run.metadata as Record<string, unknown>}
        />
      </RunDetail.FilesMetadataLayout>

      <RunDetail.Report reportData={fileReportData} files={files} />

      <RunDetail.Analysis analysisData={analysisData} />
    </>
  );
}
