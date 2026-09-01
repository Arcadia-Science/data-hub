"use client";

import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { AuntyPlateGrid } from "@/components/runs/aunty/aunty-plate-grid";
import { AuntySeriesToggle } from "@/components/runs/aunty/aunty-series-toggle";
import { PlateWellsProvider } from "@/components/runs/plate-wells-provider";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import {
  type AuntyExperiment,
  type AuntyPlateData,
  type AuntySeriesId,
  seriesForFlavor,
} from "@/lib/runs/aunty";

// The dialog pulls in Recharts and the CSV parser, which nothing on the page
// needs until a well is opened, so they load as a separate chunk.
const AuntyWellDialog = lazy(() =>
  import("@/components/runs/aunty/aunty-well-dialog").then((mod) => ({
    default: mod.AuntyWellDialog,
  }))
);

export function AuntyPlateReport({ curvesFileId, plate }: AuntyPlateData) {
  const experiments = useMemo(
    () => plate.experiments.filter((experiment) => experiment.wells.length > 0),
    [plate.experiments]
  );
  const wellCount = experiments.reduce(
    (sum, experiment) => sum + experiment.wells.length,
    0
  );

  return (
    <ReportDataShell count={wellCount}>
      <div className="flex flex-col gap-10">
        {experiments.map((experiment) => (
          <AuntyExperimentSection
            curvesFileId={curvesFileId}
            experiment={experiment}
            key={experiment.fileName}
          />
        ))}
      </div>
    </ReportDataShell>
  );
}

function AuntyExperimentSection({
  curvesFileId,
  experiment,
}: {
  curvesFileId: number | null;
  experiment: AuntyExperiment;
}) {
  const available = useMemo(
    () =>
      seriesForFlavor(
        experiment.flavor,
        Object.keys(experiment.wells[0]?.series ?? {})
      ),
    [experiment.flavor, experiment.wells]
  );
  const [seriesId, setSeriesId] = useState<AuntySeriesId>(
    available.includes(experiment.primarySeries)
      ? experiment.primarySeries
      : (available[0] ?? experiment.primarySeries)
  );
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const wellLabels = useMemo(
    () => experiment.wells.map((well) => well.well),
    [experiment.wells]
  );

  return (
    <PlateWellsProvider wells={wellLabels}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <h3 className="min-w-0 text-pretty font-medium font-mono text-foreground text-sm leading-snug">
            {experiment.fileName}
          </h3>
          <AuntySeriesToggle
            onChange={setSeriesId}
            options={available}
            value={seriesId}
          />
        </div>
        <AuntyPlateGrid
          experiment={experiment}
          onWellClick={openDialog}
          seriesId={seriesId}
        />
        <Suspense fallback={null}>
          <AuntyWellDialog
            curvesFileId={curvesFileId}
            experiment={experiment}
            onOpenChange={setOpen}
            onSeriesChange={setSeriesId}
            open={open}
            seriesId={seriesId}
            seriesOptions={available}
          />
        </Suspense>
      </div>
    </PlateWellsProvider>
  );
}
