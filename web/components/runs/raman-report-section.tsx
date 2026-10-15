"use client";

import { lazy, Suspense } from "react";
import { LoadErrorBoundary } from "@/components/load-error-boundary";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportViewerPage,
} from "@/components/runs/report-items-provider";
import { Skeleton } from "@/components/ui/skeleton";

// The charting library is a large part of the run page's script. Every run
// page imports this section, so loading the viewer here keeps the library out
// of pages for other instruments and fetches it only when a spectrum shows.
// `lazy` rather than `next/dynamic` because the MCP View bundles this file
// with Vite, which has no Next runtime.
const RamanSpectrumViewer = lazy(() =>
  import("@/components/runs/raman-spectrum-viewer").then((m) => ({
    default: m.RamanSpectrumViewer,
  }))
);

// Matches the viewer's layout, a row of series buttons above the chart, so the
// content does not jump when the chunk arrives.
function SpectrumViewerFallback() {
  return (
    <div className="flex flex-col gap-3" role="status">
      <span className="sr-only">Loading spectrum…</span>
      <div className="flex justify-end">
        <Skeleton aria-hidden className="h-8 w-48" />
      </div>
      <Skeleton aria-hidden className="h-80 w-full" />
    </div>
  );
}

export function RamanReportSection({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell count={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="spectrum">
        <ReportItemSeeker />
        <LoadErrorBoundary>
          <Suspense fallback={<SpectrumViewerFallback />}>
            <RamanSpectrumViewer />
          </Suspense>
        </LoadErrorBoundary>
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
