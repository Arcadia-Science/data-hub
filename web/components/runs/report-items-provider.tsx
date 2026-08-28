"use client";

import { createContext, type ReactNode, use, useEffect } from "react";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
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
}

const ReportItemsContext = createContext<ReportItemsContextValue | null>(null);

// Optional. The MCP View wraps carousels so the seeker can restore position
// without threading a persist key through every shared renderer.
export const ReportPersistKeyContext = createContext<string | undefined>(
  undefined
);

export function ReportItemsProvider({
  children,
  initialPage,
  kind,
}: {
  children: ReactNode;
  initialPage: ReportItemsPage;
  kind: ReportItemKind;
}) {
  const dataSource = useReportDataSource();
  const persistKey = use(ReportPersistKeyContext);
  const { state, actions } = useReportItems({
    fetchReportItems: dataSource.fetchReportItems,
    initialPage,
    kind,
  });

  useEffect(() => {
    const fileId = state.selectedItem?.id;
    if (!persistKey || fileId == null) {
      return;
    }
    try {
      window.localStorage.setItem(persistKey, JSON.stringify({ fileId }));
    } catch {
      // Private mode and quota failures are fine; restore is optional.
    }
  }, [persistKey, state.selectedItem?.id]);

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
