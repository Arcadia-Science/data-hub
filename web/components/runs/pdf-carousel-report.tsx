"use client";

import { ExternalLink } from "lucide-react";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportItemsContext,
  useReportViewerPage,
} from "@/components/runs/report-items-provider";
import { Button } from "@/components/ui/button";
import { useResolvedFileUrl } from "@/hooks/use-resolved-file-url";

function SelectedPdf() {
  const { state } = useReportItemsContext();
  const downloadUrl = useResolvedFileUrl(state.selectedItem?.id);

  if (!state.selectedItem) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        {state.error ?? (state.isLoading ? "Loading\u2026" : "No PDFs found.")}
      </div>
    );
  }

  if (!downloadUrl) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-md border bg-muted/30 text-muted-foreground text-sm">
        Loading{"\u2026"}
      </div>
    );
  }

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
        <iframe
          className="h-[70vh] w-full"
          src={downloadUrl}
          title={state.selectedItem.filename}
        />
      </div>
    </>
  );
}

// TapeStation and other PDF-primary instruments: one PDF at a time, seeked
// against the run's full PDF set.
export function PdfCarouselReport({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell total={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="pdf">
        <ReportItemSeeker />
        <SelectedPdf />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
