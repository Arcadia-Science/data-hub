"use client";

import { ExternalLink } from "lucide-react";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportItemsContext,
} from "@/components/runs/report-items-provider";
import { Button } from "@/components/ui/button";
import type { RunFile } from "@/lib/api/instrument-runs";
import { fileStem, isImageFile } from "@/lib/runs/run-file-types";

function posterUrlFor(filename: string, files: RunFile[]): string | undefined {
  const stem = fileStem(filename);
  const poster = files.find(
    (candidate) =>
      candidate.category === "processed" &&
      candidate.deletedAt === null &&
      isImageFile(candidate) &&
      fileStem(candidate.filename) === stem
  );
  return poster ? `/api/v1/files/${poster.id}/download` : undefined;
}

function SelectedVideo({ files }: { files: RunFile[] }) {
  const { state } = useReportItemsContext();

  if (!state.selectedItem) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ??
          (state.isLoading ? "Loading\u2026" : "No videos found.")}
      </div>
    );
  }

  const downloadUrl = `/api/v1/files/${state.selectedItem.id}/download`;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium text-sm">
          {state.selectedItem.filename}
        </h3>
        <Button asChild className="h-7 gap-1 text-xs" size="sm" variant="ghost">
          <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            Open in new tab
          </a>
        </Button>
      </div>
      <div className="overflow-hidden rounded-md border bg-muted/30">
        {/* biome-ignore lint/a11y/useMediaCaption: instrument preview has no captions */}
        <video
          className="h-auto max-h-[70vh] w-full"
          controls
          key={state.selectedItem.id}
          playsInline
          poster={posterUrlFor(state.selectedItem.filename, files)}
          src={downloadUrl}
        />
      </div>
    </>
  );
}

// DishCam and other video-primary instruments: one MP4 at a time, seeked
// against the run's full processed-video set. Posters are matched by stem
// from `files` because report items only carry id + filename.
export function VideoCarouselReport({
  files,
  initialPage,
  instrumentId,
  runId,
}: ReportViewerProps & { files: RunFile[] }) {
  return (
    <ReportDataShell total={initialPage.pagination.total}>
      <ReportItemsProvider
        initialPage={initialPage}
        instrumentId={instrumentId}
        kind="video"
        runId={runId}
      >
        <ReportItemSeeker />
        <SelectedVideo files={files} />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
