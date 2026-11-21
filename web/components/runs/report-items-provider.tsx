"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
import {
  type UseReportItemsResult,
  useReportItems,
} from "@/hooks/use-report-items";
import { serializePersistedFileId } from "@/lib/runs/persisted-file-id";
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
  initialPage?: ReportItemsPage;
}

const ReportItemsContext = createContext<ReportItemsContextValue | null>(null);

const ReportPersistKeyContext = createContext<string | undefined>(undefined);

const ReportViewerPageContext = createContext<ReportItemsPage | null>(null);

// Counts the deletes and restores of files on a run page, so the report below
// the files table loads its items again after one. Outside the provider the
// count stays 0 and nothing reloads.
const ReportItemsVersionContext = createContext<{
  bump: () => void;
  version: number;
}>({ bump: () => undefined, version: 0 });

export function ReportItemsVersionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);
  const value = useMemo(() => ({ bump, version }), [bump, version]);
  return (
    <ReportItemsVersionContext.Provider value={value}>
      {children}
    </ReportItemsVersionContext.Provider>
  );
}

// Tells the run page's report that files were deleted or restored.
export function useBumpReportItems(): () => void {
  return use(ReportItemsVersionContext).bump;
}

export function ReportPersistKeyProvider({
  children,
  persistKey,
}: {
  children: ReactNode;
  persistKey: string;
}) {
  return (
    <ReportPersistKeyContext.Provider value={persistKey}>
      {children}
    </ReportPersistKeyContext.Provider>
  );
}

export function ReportViewerPageProvider({
  children,
  page,
}: {
  children: ReactNode;
  page: ReportItemsPage;
}) {
  return (
    <ReportViewerPageContext.Provider value={page}>
      {children}
    </ReportViewerPageContext.Provider>
  );
}

export function useReportViewerPage(
  initialPage?: ReportItemsPage
): ReportItemsPage {
  const fromContext = use(ReportViewerPageContext);
  const page = initialPage ?? fromContext;
  if (!page) {
    throw new Error(
      "Report viewer is missing a page. Render it inside ReportViewerPageProvider or pass initialPage."
    );
  }
  return page;
}

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
  const { version } = use(ReportItemsVersionContext);
  const { state, actions } = useReportItems({
    fetchReportItems: dataSource.fetchReportItems,
    initialPage,
    kind,
    version,
  });

  useEffect(() => {
    const fileId = state.selectedItem?.id;
    if (!persistKey || fileId == null) {
      return;
    }
    try {
      window.localStorage.setItem(persistKey, serializePersistedFileId(fileId));
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
