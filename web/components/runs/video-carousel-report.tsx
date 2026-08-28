"use client";

import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportItemsContext,
} from "@/components/runs/report-items-provider";
import { RunVideoPlayer } from "@/components/runs/run-video-player";

function SelectedVideo({
  posterFileIds,
}: {
  posterFileIds: Record<string, number>;
}) {
  const { state } = useReportItemsContext();

  if (!state.selectedItem) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ??
          (state.isLoading ? "Loading\u2026" : "No videos found.")}
      </div>
    );
  }

  return (
    <RunVideoPlayer
      fileId={state.selectedItem.id}
      filename={state.selectedItem.filename}
      posterFileId={posterFileIds[state.selectedItem.filename]}
    />
  );
}

// DishCam and other video-primary instruments: one MP4 at a time, seeked
// against the run's full processed-video set. `posterFileIds` is a slim
// filename → file-id map so full `RunFile` rows never reach the client.
export function VideoCarouselReport({
  initialPage,
  posterFileIds,
}: ReportViewerProps & { posterFileIds: Record<string, number> }) {
  return (
    <ReportDataShell total={initialPage.pagination.total}>
      <ReportItemsProvider initialPage={initialPage} kind="video">
        <ReportItemSeeker />
        <SelectedVideo posterFileIds={posterFileIds} />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
