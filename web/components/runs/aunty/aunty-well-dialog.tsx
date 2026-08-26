"use client";

import { parse } from "csv-parse/browser/esm/sync";
import { AlertTriangle } from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { AuntySeriesToggle } from "@/components/runs/aunty/aunty-series-toggle";
import { AuntyWellChart } from "@/components/runs/aunty/aunty-well-chart";
import { useAuntyWells } from "@/components/runs/aunty/aunty-wells-provider";
import { SeekerToolbar } from "@/components/runs/report-item-seeker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AuntyExperiment,
  type AuntyPoint,
  type AuntySeriesId,
  curveKey,
  indexAuntyCurves,
  parseAuntyCurvesCsv,
} from "@/lib/runs/aunty";

const WELL_SEEKER_LABELS = {
  empty: "No wells found.",
  next: "Next well",
  previous: "Previous well",
  search: "Search wells...",
  select: "Select a well\u2026",
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; index: Map<string, AuntyPoint[]> }
  | { status: "error"; message: string };

type AsyncResult =
  | { fileId: number; status: "ready"; index: Map<string, AuntyPoint[]> }
  | { fileId: number; status: "error"; message: string };

async function fetchCurves(fileId: number): Promise<Map<string, AuntyPoint[]>> {
  // The download endpoint 302-redirects to a short-lived presigned S3 URL.
  // The browser follows the redirect, so the bytes come from S3 directly.
  const res = await fetch(`/api/v1/files/${fileId}/download`);
  if (!res.ok) {
    throw new Error(`Failed to load curves (HTTP ${res.status})`);
  }
  const text = await res.text();
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  return indexAuntyCurves(parseAuntyCurvesCsv(rows));
}

export function AuntyWellDialog({
  curvesFileId,
  experiment,
  onOpenChange,
  onSeriesChange,
  open,
  seriesId,
  seriesOptions,
}: {
  curvesFileId: number | null;
  experiment: AuntyExperiment;
  onOpenChange: (open: boolean) => void;
  onSeriesChange: (next: AuntySeriesId) => void;
  open: boolean;
  seriesId: AuntySeriesId;
  seriesOptions: AuntySeriesId[];
}) {
  const { state, actions } = useAuntyWells();
  const selectedWellLabel = state.selectedItem?.filename ?? null;
  const well = experiment.wells.find((w) => w.well === selectedWellLabel);
  const [retryNonce, setRetryNonce] = useState(0);
  const [asyncResult, setAsyncResult] = useState<AsyncResult | null>(null);
  const cacheRef = useRef<Map<number, Map<string, AuntyPoint[]>>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce retriggers loading state after cache clear on retry
  const loadState: LoadState = useMemo(() => {
    if (!open) {
      return { status: "idle" };
    }
    if (curvesFileId == null) {
      return { status: "ready", index: new Map() };
    }
    const cached = cacheRef.current.get(curvesFileId);
    if (cached) {
      return { status: "ready", index: cached };
    }
    if (asyncResult && asyncResult.fileId === curvesFileId) {
      return asyncResult.status === "ready"
        ? { status: "ready", index: asyncResult.index }
        : { status: "error", message: asyncResult.message };
    }
    return { status: "loading" };
  }, [asyncResult, curvesFileId, open, retryNonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce retriggers fetch when the user retries after an error
  useEffect(() => {
    if (!open || curvesFileId == null) {
      return;
    }
    if (cacheRef.current.has(curvesFileId)) {
      return;
    }
    let cancelled = false;
    fetchCurves(curvesFileId)
      .then((index) => {
        cacheRef.current.set(curvesFileId, index);
        if (cancelled) {
          return;
        }
        startTransition(() => {
          setAsyncResult({ fileId: curvesFileId, status: "ready", index });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to load curves";
        setAsyncResult({
          fileId: curvesFileId,
          status: "error",
          message,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [curvesFileId, open, retryNonce]);

  const thumbnailPoints = well?.series[seriesId] ?? [];
  const fullPoints =
    loadState.status === "ready" && selectedWellLabel
      ? (loadState.index.get(
          curveKey(experiment.fileName, selectedWellLabel, seriesId)
        ) ?? thumbnailPoints)
      : thumbnailPoints;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-3xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="font-mono text-2xl">
            {selectedWellLabel ?? "Well"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {well?.sample
              ? `Curve for well ${selectedWellLabel}, sample ${well.sample}`
              : `Curve for well ${selectedWellLabel ?? "the selected well"}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SeekerToolbar
            actions={actions}
            labels={WELL_SEEKER_LABELS}
            state={state}
          />
          <AuntySeriesToggle
            onChange={onSeriesChange}
            options={seriesOptions}
            value={seriesId}
          />
        </div>
        {loadState.status === "error" && (
          <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
            <AlertTriangle
              aria-hidden
              className="size-6 text-muted-foreground"
            />
            <p className="text-muted-foreground text-sm">{loadState.message}</p>
            <Button
              onClick={() => {
                if (curvesFileId != null) {
                  cacheRef.current.delete(curvesFileId);
                }
                setAsyncResult(null);
                setRetryNonce((n) => n + 1);
              }}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        )}
        {loadState.status === "loading" && fullPoints.length === 0 && (
          <Skeleton aria-label="Loading curve" className="h-80 w-full" />
        )}
        {well && loadState.status !== "error" && fullPoints.length > 0 && (
          <AuntyWellChart
            fileName={experiment.fileName}
            points={fullPoints}
            seriesId={seriesId}
            well={well}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
