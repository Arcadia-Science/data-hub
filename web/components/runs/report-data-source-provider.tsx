"use client";

import { createContext, type ReactNode, use, useMemo } from "react";
import { createRestReportDataSource } from "@/lib/runs/rest-report-data-source";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

const ReportDataSourceContext = createContext<ReportDataSource | null>(null);

export function ReportDataSourceProvider({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: ReportDataSource;
}) {
  return (
    <ReportDataSourceContext.Provider value={dataSource}>
      {children}
    </ReportDataSourceContext.Provider>
  );
}

// Built here, not on the server page, because the source is made of functions
// and functions cannot be passed from a server component as a prop.
export function RestReportDataSourceProvider({
  children,
  instrumentId,
  runId,
}: {
  children: ReactNode;
  instrumentId: string;
  runId: string;
}) {
  const dataSource = useMemo(
    () => createRestReportDataSource({ instrumentId, runId }),
    [instrumentId, runId]
  );
  return (
    <ReportDataSourceProvider dataSource={dataSource}>
      {children}
    </ReportDataSourceProvider>
  );
}

export function useReportDataSource(): ReportDataSource {
  const dataSource = use(ReportDataSourceContext);
  if (!dataSource) {
    throw new Error(
      "useReportDataSource must be used within a <ReportDataSourceProvider>"
    );
  }
  return dataSource;
}
