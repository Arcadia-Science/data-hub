"use client";

import { usePlateWellsState } from "@/components/runs/plate-wells-provider";
import { QpcrMeltingSeriesToggle } from "@/components/runs/qpcr/qpcr-melting-series-toggle";
import { QpcrMeltingWellChart } from "@/components/runs/qpcr/qpcr-melting-well-chart";
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
  indexQpcrMeltingCurves,
  meltingCurveKey,
  type QpcrMeltingChannel,
  type QpcrMeltingCurveIndex,
  type QpcrMeltingSeriesId,
  type QpcrMeltingWellCurves,
} from "@/lib/runs/qpcr-melting";

const loadCurves = createCachedCurveLoader<QpcrMeltingCurveIndex>(
  async (dataSource, fileId) => {
    const { rows } = await dataSource.fetchTableRows(fileId);
    return indexQpcrMeltingCurves(rows);
  }
);

export function QpcrMeltingWellDialog({
  channel,
  derivativesCsvFileId,
  onOpenChange,
  onSeriesChange,
  open,
  seriesIds,
}: {
  channel: QpcrMeltingChannel;
  derivativesCsvFileId: number | null;
  onOpenChange: (open: boolean) => void;
  onSeriesChange: (next: QpcrMeltingSeriesId[]) => void;
  open: boolean;
  seriesIds: readonly QpcrMeltingSeriesId[];
}) {
  const state = usePlateWellsState();
  const selectedWellLabel = state.selectedItem?.filename ?? null;
  const { retry, state: curves } = useWellCurves({
    fileId: derivativesCsvFileId,
    load: loadCurves,
    open,
  });

  const wellCurves = curvesForWell({
    channel,
    curves,
    well: selectedWellLabel,
  });

  return (
    <WellDialogShell
      controls={
        <QpcrMeltingSeriesToggle onChange={onSeriesChange} value={seriesIds} />
      }
      // Radix wants a description for the dialog's accessible name, and the
      // heading no longer says what is being plotted.
      description={
        selectedWellLabel
          ? `Melting curve for well ${selectedWellLabel} in ${channel.channel}`
          : `Melting curves for ${channel.channel}`
      }
      onOpenChange={onOpenChange}
      open={open}
      title={
        selectedWellLabel
          ? `${channel.channel} \u2013 ${selectedWellLabel}`
          : channel.channel
      }
    >
      <WellCurveBody
        curves={curves}
        onRetry={retry}
        seriesIds={seriesIds}
        wellCurves={wellCurves}
      />
    </WellDialogShell>
  );
}

function WellCurveBody({
  curves,
  onRetry,
  seriesIds,
  wellCurves,
}: {
  curves: CurvesState<QpcrMeltingCurveIndex>;
  onRetry: () => void;
  seriesIds: readonly QpcrMeltingSeriesId[];
  wellCurves: Partial<QpcrMeltingWellCurves>;
}) {
  if (curves.status === "error") {
    return <CurveLoadError message={curves.message} onRetry={onRetry} />;
  }
  if (seriesIds.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Turn on a series above to plot this well.
      </p>
    );
  }
  // The thinned plate points stand in until the CSV lands, so a curve is on
  // screen straight away and only sharpens when the download finishes.
  if (seriesIds.some((id) => (wellCurves[id]?.length ?? 0) > 0)) {
    return <QpcrMeltingWellChart curves={wellCurves} seriesIds={seriesIds} />;
  }
  if (curves.status === "loading") {
    return <CurveLoading />;
  }
  return (
    <p className="text-muted-foreground text-sm">No data for this well.</p>
  );
}

// Prefers the full-resolution CSV curves and falls back to the thinned points
// the plate grid is already drawing, so the chart is never blank while the
// download is in flight.
function curvesForWell({
  channel,
  curves,
  well,
}: {
  channel: QpcrMeltingChannel;
  curves: CurvesState<QpcrMeltingCurveIndex>;
  well: string | null;
}): Partial<QpcrMeltingWellCurves> {
  if (!well) {
    return {};
  }
  const thinned = channel.wells.find((w) => w.well === well)?.series ?? {};
  if (curves.status !== "ready") {
    return thinned;
  }
  return curves.index.get(meltingCurveKey(channel.channel, well)) ?? thinned;
}
