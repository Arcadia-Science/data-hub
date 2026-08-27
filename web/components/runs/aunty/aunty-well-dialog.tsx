"use client";

import { parse } from "csv-parse/browser/esm/sync";
import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuntySeriesToggle } from "@/components/runs/aunty/aunty-series-toggle";
import { AuntyWellChart } from "@/components/runs/aunty/aunty-well-chart";
import {
  useAuntyWellsActions,
  useAuntyWellsState,
} from "@/components/runs/aunty/aunty-wells-provider";
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
  presentWellValues,
} from "@/lib/runs/aunty";

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
  | { status: "ready"; index: Map<string, AuntyPoint[]> }
  | { status: "error"; message: string };

// Module scope, so a run with several experiments downloads each curves file
// once instead of once per dialog. Failures evict themselves for Retry.
const curvesCache = new Map<number, Promise<Map<string, AuntyPoint[]>>>();

async function downloadCurves(
  fileId: number
): Promise<Map<string, AuntyPoint[]>> {
  // The download endpoint 302-redirects to a short-lived presigned S3 URL, so
  // the browser follows the redirect and reads the bytes straight from S3.
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

function loadCurves(fileId: number): Promise<Map<string, AuntyPoint[]>> {
  const cached = curvesCache.get(fileId);
  if (cached) {
    return cached;
  }
  const pending = downloadCurves(fileId).catch((err: unknown) => {
    curvesCache.delete(fileId);
    throw err;
  });
  curvesCache.set(fileId, pending);
  return pending;
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
  const state = useAuntyWellsState();
  const actions = useAuntyWellsActions();
  const selectedWellLabel = state.selectedItem?.filename ?? null;
  const well = experiment.wells.find((w) => w.well === selectedWellLabel);

  const [curves, setCurves] = useState<CurvesState>({ status: "idle" });
  const requestId = useRef(0);

  const startLoad = useCallback((fileId: number) => {
    const id = requestId.current + 1;
    requestId.current = id;
    setCurves({ status: "loading" });
    loadCurves(fileId)
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
  }, []);

  useEffect(() => {
    if (open && curvesFileId != null) {
      startLoad(curvesFileId);
    }
  }, [curvesFileId, open, startLoad]);

  const thumbnailPoints = well?.series[seriesId] ?? [];
  const fullPoints =
    curves.status === "ready" && selectedWellLabel
      ? (curves.index.get(
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
        {curves.status === "error" && (
          <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
            <AlertTriangle
              aria-hidden
              className="size-6 text-muted-foreground"
            />
            <p className="text-muted-foreground text-sm">{curves.message}</p>
            <Button
              onClick={() => {
                if (curvesFileId != null) {
                  startLoad(curvesFileId);
                }
              }}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        )}
        {curves.status === "loading" && fullPoints.length === 0 && (
          <Skeleton aria-label="Loading curve" className="h-80 w-full" />
        )}
        {well && curves.status !== "error" && fullPoints.length > 0 && (
          <AuntyWellChart
            fileName={experiment.fileName}
            flavor={experiment.flavor}
            points={fullPoints}
            seriesId={seriesId}
            well={well}
          />
        )}
        {well && (
          <AuntyWellValuesList
            showEmpty={fullPoints.length === 0 && curves.status !== "loading"}
            well={well}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AuntyWellValuesList({
  showEmpty,
  well,
}: {
  showEmpty: boolean;
  well: NonNullable<AuntyExperiment["wells"][number]>;
}) {
  const items = presentWellValues(well.values);
  if (items.length === 0) {
    if (!showEmpty) {
      return null;
    }
    return (
      <p className="text-muted-foreground text-sm">
        No summary values for this well.
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map((item) => (
        <div className="contents" key={item.label}>
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="font-mono tabular-nums">{item.text}</dd>
        </div>
      ))}
    </dl>
  );
}
