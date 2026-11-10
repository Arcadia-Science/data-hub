"use client";

import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportImage } from "@/components/runs/report-image";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportItemsContext,
  useReportViewerPage,
} from "@/components/runs/report-items-provider";
import { RunVideoPlayer } from "@/components/runs/run-video-player";
import { isVideoFile } from "@/lib/runs/run-file-types";

function SelectedMedia() {
  const { state } = useReportItemsContext();
  const item = state.selectedItem;

  if (!item) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ??
          (state.isLoading ? "Loading…" : "No images or videos found.")}
      </div>
    );
  }

  return isVideoFile({ contentType: null, filename: item.filename }) ? (
    <RunVideoPlayer
      fileId={item.id}
      filename={item.filename}
      posterFileId={item.poster_id ?? undefined}
    />
  ) : (
    <ReportImage fileId={item.id} filename={item.filename} />
  );
}

// Hina microscope: one item per source file, seeked against the run's full
// set. A timelapse plays as its MP4 with its still JPG as the poster; any
// other file shows its JPG. The API pairs each video with its poster.
export function MediaCarouselReport({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell count={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="media">
        <ReportItemSeeker />
        <SelectedMedia />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
