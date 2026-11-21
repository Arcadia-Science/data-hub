import type { ReactNode } from "react";
import { CancelQueuedDialog } from "@/components/runs/cancel-queued-dialog";
import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import { RunDetail, type RunDetailProps } from "@/components/runs/run-detail";
import { RunOfflineNotice } from "@/components/runs/run-offline-notice";
import { UploadFailedNotice } from "@/components/runs/upload-failed-notice";
import { canCancelQueued } from "@/lib/runs/cancel-queued";

type RunDetailLayoutProps = Pick<
  RunDetailProps,
  | "attributionsSlot"
  | "fileStats"
  | "files"
  | "filesDeletedCount"
  | "filesDownloadableCount"
  | "filesPagination"
  | "instrumentId"
  | "notebooksSlot"
  | "run"
  | "runId"
  | "runNavSlot"
> & {
  // Instrument-specific metadata badges, shown inside the summary card.
  badges?: ReactNode;
  // The instrument's report, rendered below the files table.
  children: ReactNode;
};

/**
 * The part of a run page that every instrument shares: the header with its
 * cancel-queued and delete or restore buttons, the metadata card, the lab
 * notebooks, and the files table. A variant supplies only what differs, its metadata badges and its
 * report, so a new header action or a change to the files layout happens here
 * once.
 */
export function RunDetailLayout({
  attributionsSlot,
  badges,
  children,
  fileStats,
  files,
  filesDeletedCount,
  filesDownloadableCount,
  filesPagination,
  instrumentId,
  notebooksSlot,
  run,
  runId,
  runNavSlot,
}: RunDetailLayoutProps) {
  const isDeleted = run.deletedAt !== null;

  return (
    <>
      <RunDetail.Header run={run} runNavSlot={runNavSlot}>
        {canCancelQueued(fileStats) && (
          <CancelQueuedDialog
            instrumentId={instrumentId}
            queuedCount={fileStats.queued}
            runId={runId}
          />
        )}
        {isDeleted ? (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        ) : (
          <DeleteRunDialog
            fileCount={fileStats.active}
            hasProcessedFiles={fileStats.processedActive > 0}
            instrumentId={instrumentId}
            runId={runId}
          />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Metadata
          attributionsSlot={attributionsSlot}
          fileStats={fileStats}
          run={run}
        >
          {badges}
        </RunDetail.Metadata>
        {notebooksSlot}
        {/* A deleted run can't queue uploads, so what is left on the PC is
            not worth a warning. */}
        {isDeleted ? null : (
          <RunOfflineNotice waitingFileCount={fileStats.pending} />
        )}
        {isDeleted ? null : (
          <UploadFailedNotice
            groups={fileStats.uploadFailureGroups}
            instrumentId={instrumentId}
            runId={runId}
          />
        )}
        <RunDetail.Files
          deletedCount={filesDeletedCount}
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

      {children}
    </>
  );
}
