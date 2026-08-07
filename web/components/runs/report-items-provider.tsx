"use client";

import { createContext, type ReactNode, use } from "react";
import {
  type UseReportItemsResult,
  useReportItems,
} from "@/hooks/use-report-items";
import type { ReportItemKind, ReportItemsPage } from "@/lib/runs/report-items";

// Mirrors FileSelectionProvider in shape (state / actions / meta). Owns the
// item list so the seeker and the viewer body share one selection.
export interface ReportItemsContextValue extends UseReportItemsResult {
  meta: {
    kind: ReportItemKind;
  };
}

// Props every report-data viewer receives from its run-detail variant.
export interface ReportViewerProps {
  initialPage: ReportItemsPage;
  instrumentId: string;
  runId: string;
}

const ReportItemsContext = createContext<ReportItemsContextValue | null>(null);

export function ReportItemsProvider({
  children,
  initialPage,
  instrumentId,
  kind,
  runId,
}: {
  children: ReactNode;
  initialPage: ReportItemsPage;
  instrumentId: string;
  kind: ReportItemKind;
  runId: string;
}) {
  const { state, actions } = useReportItems({
    initialPage,
    instrumentId,
    kind,
    runId,
  });

  return (
    <ReportItemsContext.Provider value={{ state, actions, meta: { kind } }}>
      {children}
    </ReportItemsContext.Provider>
  );
}

export function useReportItemsContext(): ReportItemsContextValue {
  const context = use(ReportItemsContext);
  if (!context) {
    throw new Error(
      "useReportItemsContext must be used within a <ReportItemsProvider>"
    );
  }
  return context;
}
