import { useCallback, useEffect, useRef, useState } from "react";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

export type CurvesState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; index: T }
  | { status: "error"; message: string };

type Download<T> = (dataSource: ReportDataSource, fileId: number) => Promise<T>;

/**
 * Wraps a curve download in a cache that lives for the whole page session. A
 * run with several experiments or channels then fetches each file once instead
 * of once per dialog. A failed download leaves the cache, so Retry tries again.
 */
export function createCachedCurveLoader<T>(download: Download<T>) {
  const cache = new Map<number, Promise<T>>();
  return function load(
    dataSource: ReportDataSource,
    fileId: number
  ): Promise<T> {
    const cached = cache.get(fileId);
    if (cached) {
      return cached;
    }
    const pending = download(dataSource, fileId).catch((err: unknown) => {
      cache.delete(fileId);
      throw err;
    });
    cache.set(fileId, pending);
    return pending;
  };
}

/**
 * Loads a well dialog's full-resolution curves each time it opens. Plate tiles
 * already hold thinned points, so callers draw those until `state` is ready.
 * A response that lands after a newer request started is ignored.
 */
export function useWellCurves<T>({
  fileId,
  load,
  open,
}: {
  fileId: number | null;
  load: (dataSource: ReportDataSource, fileId: number) => Promise<T>;
  open: boolean;
}) {
  const dataSource = useReportDataSource();
  const [state, setState] = useState<CurvesState<T>>({ status: "idle" });
  const requestId = useRef(0);

  const start = useCallback(
    (id: number) => {
      const request = requestId.current + 1;
      requestId.current = request;
      setState({ status: "loading" });
      load(dataSource, id)
        .then((index) => {
          if (requestId.current === request) {
            setState({ status: "ready", index });
          }
        })
        .catch((err: unknown) => {
          if (requestId.current === request) {
            setState({
              status: "error",
              message:
                err instanceof Error ? err.message : "Failed to load curves",
            });
          }
        });
    },
    [dataSource, load]
  );

  useEffect(() => {
    if (open && fileId != null) {
      start(fileId);
    }
  }, [fileId, open, start]);

  const retry = useCallback(() => {
    if (fileId != null) {
      start(fileId);
    }
  }, [fileId, start]);

  return { retry, state };
}
