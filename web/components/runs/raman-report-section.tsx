"use client";

import { RamanSpectrumViewer } from "@/components/runs/raman-spectrum-viewer";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
  useReportViewerPage,
} from "@/components/runs/report-items-provider";

export function RamanReportSection({ initialPage }: ReportViewerProps) {
  const page = useReportViewerPage(initialPage);
  return (
    <ReportDataShell count={page.pagination.total}>
      <ReportItemsProvider initialPage={page} kind="spectrum">
        <ReportItemSeeker />
        <RamanSpectrumViewer />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
