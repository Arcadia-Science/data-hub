"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  usePlateWellsActions,
  usePlateWellsState,
} from "@/components/runs/plate-wells-provider";
import { QpcrMeltingSeriesToggle } from "@/components/runs/qpcr/qpcr-melting-series-toggle";
import { QpcrMeltingWellChart } from "@/components/runs/qpcr/qpcr-melting-well-chart";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
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
  indexQpcrMeltingCurves,
  meltingCurveKey,
  QPCR_MELTING_SERIES_META,
  type QpcrMeltingChannel,
  type QpcrMeltingCurveIndex,
  type QpcrMeltingPoint,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

const WELL_SEEKER_LABELS = {
  empty: "No wells found.",
  next: "Next well",
  previous: "Previous well",
  search: "Search wells...",
  select: "Select a well\u2026",
};

type CurvesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; index: QpcrMeltingCurveIndex }
  | { status: "error"; message: string };

// Module scope, so a run with several channels downloads the one derivatives
// file once instead of once per dialog. Failures evict themselves for Retry.
const curvesCache = new Map<number, Promise<QpcrMeltingCurveIndex>>();

async function downloadCurves(
  dataSource: ReportDataSource,
  fileId: number
): Promise<QpcrMeltingCurveIndex> {
  const { rows } = await dataSource.fetchTableRows(fileId);
  return indexQpcrMeltingCurves(rows);
}

function loadCurves(
  dataSource: ReportDataSource,
  fileId: number
): Promise<QpcrMeltingCurveIndex> {
  const cached = curvesCache.get(fileId);
  if (cached) {
    return cached;
  }
  const pending = downloadCurves(dataSource, fileId).catch((err: unknown) => {
    curvesCache.delete(fileId);
    throw err;
  });
  curvesCache.set(fileId, pending);
  return pending;
}

export function QpcrMeltingWellDialog({
  channel,
  derivativesCsvFileId,
  onOpenChange,
  onSeriesChange,
  open,
  seriesId,
}: {
  channel: QpcrMeltingChannel;
  derivativesCsvFileId: number | null;
  onOpenChange: (open: boolean) => void;
  onSeriesChange: (next: QpcrMeltingSeriesId) => void;
  open: boolean;
  seriesId: QpcrMeltingSeriesId;
}) {
  const dataSource = useReportDataSource();
  const state = usePlateWellsState();
  const actions = usePlateWellsActions();
  const selectedWellLabel = state.selectedItem?.filename ?? null;

  const [curves, setCurves] = useState<CurvesState>({ status: "idle" });
  const requestId = useRef(0);

  const startLoad = useCallback(
    (fileId: number) => {
      const id = requestId.current + 1;
      requestId.current = id;
      setCurves({ status: "loading" });
      loadCurves(dataSource, fileId)
        .then((index) => {
          if (requestId.current === id) {
            setCurves({ status: "ready", index });
          }
        })
        .catch((err: unknown) => {
          if (requestId.current === id) {
            setCurves({
              status: "error",
              message:
                err instanceof Error ? err.message : "Failed to load curves",
            });
          }
        });
    },
    [dataSource]
  );

  useEffect(() => {
    if (open && derivativesCsvFileId != null) {
      startLoad(derivativesCsvFileId);
    }
  }, [derivativesCsvFileId, open, startLoad]);

  const retry = useCallback(() => {
    if (derivativesCsvFileId != null) {
      startLoad(derivativesCsvFileId);
    }
  }, [derivativesCsvFileId, startLoad]);

  const points = wellPoints({
    channel,
    curves,
    seriesId,
    well: selectedWellLabel,
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-3xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="font-mono text-2xl">
            {selectedWellLabel ?? "Well"}
          </DialogTitle>
          <DialogDescription>{channel.channel} melting curve</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SeekerToolbar
            actions={actions}
            labels={WELL_SEEKER_LABELS}
            state={state}
          />
          <QpcrMeltingSeriesToggle onChange={onSeriesChange} value={seriesId} />
        </div>
        <WellCurveBody
          curves={curves}
          onRetry={retry}
          points={points}
          seriesId={seriesId}
        />
      </DialogContent>
    </Dialog>
  );
}

function WellCurveBody({
  curves,
  onRetry,
  points,
  seriesId,
}: {
  curves: CurvesState;
  onRetry: () => void;
  points: QpcrMeltingPoint[];
  seriesId: QpcrMeltingSeriesId;
}) {
  if (curves.status === "error") {
    return (
      <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
        <AlertTriangle aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">{curves.message}</p>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </div>
    );
  }
  // The thinned plate points stand in until the CSV lands, so the derivative
  // is on screen straight away and only sharpens when the download finishes.
  if (points.length > 0) {
    return <QpcrMeltingWellChart points={points} seriesId={seriesId} />;
  }
  if (curves.status === "loading") {
    return <Skeleton aria-label="Loading curve" className="h-80 w-full" />;
  }
  return (
    <p className="text-muted-foreground text-sm">
      No {QPCR_MELTING_SERIES_META[seriesId].label.toLowerCase()} data for this
      well.
    </p>
  );
}

// Prefers the full-resolution CSV curve and falls back to the thinned points
// the plate grid is already drawing, so the chart is never blank while the
// download is in flight.
function wellPoints({
  channel,
  curves,
  seriesId,
  well,
}: {
  channel: QpcrMeltingChannel;
  curves: CurvesState;
  seriesId: QpcrMeltingSeriesId;
  well: string | null;
}): QpcrMeltingPoint[] {
  if (!well) {
    return [];
  }
  const thinned =
    channel.wells.find((w) => w.well === well)?.series[seriesId] ?? [];
  if (curves.status !== "ready") {
    return thinned;
  }
  const full = curves.index.get(meltingCurveKey(channel.channel, well));
  return full?.[seriesId] ?? thinned;
}
