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

function SelectedImage() {
  const { state } = useReportItemsContext();

  if (!state.selectedItem) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ?? (state.isLoading ? "Loading…" : "No images found.")}
      </div>
    );
  }

  return (
    <ReportImage
      fileId={state.selectedItem.id}
      filename={state.selectedItem.filename}
    />
  );
}

// For instruments whose report data is purely imagery (gel doc): one image
// at a time, seeked against the run's full image set.
export function ImageCarouselReport({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell count={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="image">
        <ReportItemSeeker />
        <SelectedImage />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
