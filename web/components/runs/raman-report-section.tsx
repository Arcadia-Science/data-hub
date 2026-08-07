"use client";

import { RamanSpectrumViewer } from "@/components/runs/raman-spectrum-viewer";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import { ReportItemSeeker } from "@/components/runs/report-item-seeker";
import {
  ReportItemsProvider,
  type ReportViewerProps,
} from "@/components/runs/report-items-provider";

export function RamanReportSection({
  initialPage,
  instrumentId,
  runId,
}: ReportViewerProps) {
  return (
    <ReportDataShell total={initialPage.pagination.total}>
      <ReportItemsProvider
        initialPage={initialPage}
        instrumentId={instrumentId}
        kind="spectrum"
        runId={runId}
      >
        <ReportItemSeeker />
        <RamanSpectrumViewer />
      </ReportItemsProvider>
    </ReportDataShell>
  );
}
