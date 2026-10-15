"use client";

import { lazy, Suspense } from "react";
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

export function RamanReportSection({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell count={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="spectrum">
        <ReportItemSeeker />
        <Suspense
          fallback={
            <Skeleton aria-label="Loading spectrum" className="h-80 w-full" />
          }
        >
          <RamanSpectrumViewer />
        </Suspense>
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
