"use client";

import { parse } from "csv-parse/browser/esm/sync";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RunFile } from "@/lib/api/instrument-runs";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 10;

type CsvRow = Record<string, string>;

async function fetchCsvRows(fileId: number): Promise<CsvRow[]> {
  // The download endpoint 302-redirects to a short-lived presigned S3 URL;
  // the browser follows transparently, so CSV bytes flow directly from S3
  // with zero Vercel Fast Origin Transfer.
  const res = await fetch(`/api/v1/files/${fileId}/download`);
  if (!res.ok) {
    throw new Error(`Failed to load CSV (HTTP ${res.status})`);
  }
  const text = await res.text();
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];
}

type AsyncResult =
  | { fileId: number; status: "ready"; rows: CsvRow[] }
  | { fileId: number; status: "error"; message: string };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; rows: CsvRow[] }
  | { status: "error"; message: string };

export function ColonyDataTable({ file }: { file: RunFile }) {
  const downloadUrl = `/api/v1/files/${file.id}/download`;
  const fileId = file.id;

  const [asyncResult, setAsyncResult] = useState<AsyncResult | null>(null);
  // Bumped on retry to invalidate any cached error and re-run the load effect.
  const [retryNonce, setRetryNonce] = useState(0);
  const [page, setPage] = useState(0);

  // Per-mount cache so re-mounting (e.g. drawer toggles) doesn't refetch the
  // same CSV from S3. Keyed by fileId so multiple tables share nothing.
  const cacheRef = useRef<Map<number, CsvRow[]>>(new Map());

  const state: LoadState = useMemo(() => {
    const cached = cacheRef.current.get(fileId);
    if (cached) {
      return { status: "ready", rows: cached };
    }
    if (asyncResult && asyncResult.fileId === fileId) {
      return asyncResult.status === "ready"
        ? { status: "ready", rows: asyncResult.rows }
        : { status: "error", message: asyncResult.message };
    }
    return { status: "loading" };
  }, [fileId, asyncResult]);

  useEffect(() => {
    void retryNonce;
    if (cacheRef.current.has(fileId)) {
      return;
    }
    let cancelled = false;
    fetchCsvRows(fileId)
      .then((rows) => {
        cacheRef.current.set(fileId, rows);
        if (cancelled) {
          return;
        }
        setAsyncResult({ fileId, status: "ready", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to load CSV";
        setAsyncResult({ fileId, status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [fileId, retryNonce]);

  function handleRetry() {
    cacheRef.current.delete(fileId);
    setAsyncResult(null);
    setRetryNonce((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">{file.filename}</h3>
        <Button asChild className="h-7 gap-1 text-xs" size="sm" variant="ghost">
          <a href={downloadUrl} rel="noopener noreferrer" target="_blank">
            <ExternalLink className="size-3" />
            Open as CSV
          </a>
        </Button>
      </div>
      {state.status === "loading" && (
        <Skeleton aria-label="Loading CSV" className="h-72 w-full" />
      )}
      {state.status === "error" && (
        <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
          <AlertTriangle aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">{state.message}</p>
          <Button onClick={handleRetry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {state.status === "ready" && (
        <ColonyDataTableView
          onPageChange={setPage}
          page={page}
          rows={state.rows}
        />
      )}
    </div>
  );
}

function ColonyDataTableView({
  rows,
  page,
  onPageChange,
}: {
  rows: CsvRow[];
  page: number;
  onPageChange: (next: number) => void;
}) {
  const columns = useMemo<string[]>(
    () => (rows.length === 0 ? [] : Object.keys(rows[0])),
    [rows]
  );

  // Right-align columns whose first non-empty value parses as a finite number.
  // Computed once per row set so per-cell rendering stays cheap.
  const numericColumns = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    if (rows.length === 0) {
      return out;
    }
    for (const col of columns) {
      for (const row of rows) {
        const v = row[col];
        if (v === undefined || v === "") {
          continue;
        }
        if (!Number.isNaN(Number(v)) && Number.isFinite(Number(v))) {
          out.add(col);
        }
        break;
      }
    }
    return out;
  }, [rows, columns]);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Clamp the current page in case the row set shrinks (e.g. after retry).
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);

  const pageRows = useMemo(() => rows.slice(start, end), [rows, start, end]);

  if (total === 0) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed bg-muted/20 text-muted-foreground text-sm">
        CSV is empty.
      </div>
    );
  }

  const canGoPrev = safePage > 0;
  const canGoNext = safePage < totalPages - 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  className={cn(
                    "font-mono text-xs",
                    numericColumns.has(col) && "text-right"
                  )}
                  key={col}
                >
                  {col}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row) => (
              <TableRow
                key={columns.map((col) => `${col}:${row[col] ?? ""}`).join("|")}
              >
                {columns.map((col) => (
                  <TableCell
                    className={cn(
                      "font-mono text-xs",
                      numericColumns.has(col) && "text-right tabular-nums"
                    )}
                    key={col}
                  >
                    {row[col] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>
          Showing <span className="tabular-nums">{start + 1}</span>–
          <span className="tabular-nums">{end}</span> of{" "}
          <span className="tabular-nums">{total}</span>
        </span>
        <div className="flex items-center gap-2">
          <span className="tabular-nums">
            Page {safePage + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              aria-label="Previous page"
              disabled={!canGoPrev}
              onClick={() => onPageChange(safePage - 1)}
              size="icon"
              variant="outline"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              aria-label="Next page"
              disabled={!canGoNext}
              onClick={() => onPageChange(safePage + 1)}
              size="icon"
              variant="outline"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
