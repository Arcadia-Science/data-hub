"use client";

import { useEffect, useState } from "react";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";

// REST returns a path string synchronously; the View's MCP source returns a
// Promise (fresh presigned URL). Read the sync path during render so the
// carousel never paints the previous file's URL for a frame.
export function useResolvedFileUrl(
  fileId: number | null | undefined
): string | null {
  const dataSource = useReportDataSource();
  const [asyncResult, setAsyncResult] = useState<{
    fileId: number;
    url: string;
  } | null>(null);

  const resolved =
    fileId == null ? undefined : dataSource.resolveFileUrl(fileId);

  useEffect(() => {
    if (fileId == null || resolved == null || typeof resolved === "string") {
      return;
    }
    let cancelled = false;
    resolved.then((url) => {
      if (!cancelled) {
        setAsyncResult({ fileId, url });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileId, resolved]);

  if (fileId == null) {
    return null;
  }
  if (typeof resolved === "string") {
    return resolved;
  }
  if (asyncResult?.fileId === fileId) {
    return asyncResult.url;
  }
  return null;
}
