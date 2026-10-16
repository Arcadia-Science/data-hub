"use client";

import { AuntySeriesToggle } from "@/components/runs/aunty/aunty-series-toggle";
import { AuntyWellChart } from "@/components/runs/aunty/aunty-well-chart";
import { usePlateWellsState } from "@/components/runs/plate-wells-provider";
import {
  type CurvesState,
  createCachedCurveLoader,
  useWellCurves,
} from "@/components/runs/well-curves";
import {
  CurveLoadError,
  CurveLoading,
  WellDialogShell,
} from "@/components/runs/well-dialog-shell";
import {
  type AuntyExperiment,
  type AuntyPoint,
  type AuntySeriesId,
  curveKey,
  indexAuntyCurves,
  parseAuntyCurvesCsv,
  presentWellValues,
} from "@/lib/runs/aunty";

type AuntyCurves = Map<string, AuntyPoint[]>;

const loadCurves = createCachedCurveLoader<AuntyCurves>(
  async (dataSource, fileId) => {
    const { rows } = await dataSource.fetchTableRows(fileId);
    return indexAuntyCurves(parseAuntyCurvesCsv(rows));
  }
);

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
  const state = usePlateWellsState();
  const selectedWellLabel = state.selectedItem?.filename ?? null;
  const well = experiment.wells.find((w) => w.well === selectedWellLabel);
  const { retry, state: curves } = useWellCurves({
    fileId: curvesFileId,
    load: loadCurves,
    open,
  });

  const thumbnailPoints = well?.series[seriesId] ?? [];
  const fullPoints = pointsForWell({
    curves,
    experiment,
    seriesId,
    thumbnailPoints,
    well: selectedWellLabel,
  });

  return (
    <WellDialogShell
      controls={
        <AuntySeriesToggle
          onChange={onSeriesChange}
          options={seriesOptions}
          value={seriesId}
        />
      }
      description={
        well?.sample
          ? `Curve for well ${selectedWellLabel}, sample ${well.sample}`
          : `Curve for well ${selectedWellLabel ?? "the selected well"}`
      }
      onOpenChange={onOpenChange}
      open={open}
      title={selectedWellLabel ?? "Well"}
    >
      {curves.status === "error" && (
        <CurveLoadError message={curves.message} onRetry={retry} />
      )}
      {curves.status === "loading" && fullPoints.length === 0 && (
        <CurveLoading />
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
    </WellDialogShell>
  );
}

// Prefers the full-resolution CSV curve and falls back to the thinned points
// the plate grid is already drawing, so the chart is never blank while the
// download is in flight.
function pointsForWell({
  curves,
  experiment,
  seriesId,
  thumbnailPoints,
  well,
}: {
  curves: CurvesState<AuntyCurves>;
  experiment: AuntyExperiment;
  seriesId: AuntySeriesId;
  thumbnailPoints: AuntyPoint[];
  well: string | null;
}): AuntyPoint[] {
  if (curves.status !== "ready" || !well) {
    return thumbnailPoints;
  }
  return (
    curves.index.get(curveKey(experiment.fileName, well, seriesId)) ??
    thumbnailPoints
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
