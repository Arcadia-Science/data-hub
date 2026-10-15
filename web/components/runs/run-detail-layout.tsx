import type { ReactNode } from "react";
import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import { RunDetail, type RunDetailProps } from "@/components/runs/run-detail";

type RunDetailLayoutProps = Pick<
  RunDetailProps,
  | "attributionsSlot"
  | "fileStats"
  | "files"
  | "filesDownloadableCount"
  | "filesPagination"
  | "instrumentId"
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
 * delete or restore button, the metadata card, and the files table. A variant
 * supplies only what differs, its metadata badges and its report, so a new
 * header action or a change to the files layout happens here once.
 */
export function RunDetailLayout({
  attributionsSlot,
  badges,
  children,
  fileStats,
  files,
  filesDownloadableCount,
  filesPagination,
  instrumentId,
  run,
  runId,
  runNavSlot,
}: RunDetailLayoutProps) {
  const isDeleted = run.deletedAt !== null;

  return (
    <>
      <RunDetail.Header run={run} runNavSlot={runNavSlot}>
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

      {children}
    </>
  );
}
