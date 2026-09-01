"use client";

import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportItemsContext,
  useReportViewerPage,
} from "@/components/runs/report-items-provider";
import { useResolvedFileUrl } from "@/hooks/use-resolved-file-url";

function SelectedImage() {
  const { state } = useReportItemsContext();
  const src = useResolvedFileUrl(state.selectedItem?.id);

  if (!state.selectedItem) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ??
          (state.isLoading ? "Loading\u2026" : "No images found.")}
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex h-64 items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        Loading{"\u2026"}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      {/* biome-ignore lint/performance/noImgElement: auth-gated download URLs are not next/image candidates */}
      <img
        alt={state.selectedItem.filename}
        className="mx-auto block max-h-[70vh] w-auto object-contain"
        height={600}
        src={src}
        width={800}
      />
    </div>
  );
}

// For instruments whose report data is purely imagery (Hina microscope, gel
// doc): one image at a time, seeked against the run's full image set.
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
