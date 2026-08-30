"use client";

import { useEffect, useState } from "react";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

export function peekSyncFileUrl(
  dataSource: ReportDataSource,
  fileId: number
): string | undefined {
  return dataSource.peekFileUrl?.(fileId) ?? undefined;
}

// Only the effect may call `resolveFileUrl`: the View's MCP source is async,
// so calling it during render allocates a new Promise every pass and loops.
export function useResolvedFileUrl(
  fileId: number | null | undefined
): string | null {
  const dataSource = useReportDataSource();
  const [asyncResult, setAsyncResult] = useState<{
    fileId: number;
    url: string;
  } | null>(null);

  const syncUrl =
    fileId == null ? undefined : peekSyncFileUrl(dataSource, fileId);

  useEffect(() => {
    if (fileId == null || syncUrl != null) {
      return;
    }
    let cancelled = false;
    const pending = dataSource.resolveFileUrl(fileId);
    if (typeof pending === "string") {
      setAsyncResult({ fileId, url: pending });
      return;
    }
    pending
      .then((url) => {
        if (!cancelled) {
          setAsyncResult({ fileId, url });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAsyncResult(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, fileId, syncUrl]);

  if (fileId == null) {
    return null;
  }
  if (syncUrl != null) {
    return syncUrl;
  }
  if (asyncResult?.fileId === fileId) {
    return asyncResult.url;
  }
  return null;
}
