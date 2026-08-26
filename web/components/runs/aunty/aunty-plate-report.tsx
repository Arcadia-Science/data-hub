"use client";

import { useState } from "react";
import { AuntyPlateGrid } from "@/components/runs/aunty/aunty-plate-grid";
import { AuntySeriesToggle } from "@/components/runs/aunty/aunty-series-toggle";
import { AuntyWellDialog } from "@/components/runs/aunty/aunty-well-dialog";
import { AuntyWellsProvider } from "@/components/runs/aunty/aunty-wells-provider";
import { ReportDataShell } from "@/components/runs/report-data-shell";
import {
  type AuntyExperiment,
  type AuntyPlateData,
  type AuntySeriesId,
  seriesForFlavor,
} from "@/lib/runs/aunty";

export function AuntyPlateReport({ curvesFileId, plate }: AuntyPlateData) {
  const experiments = plate.experiments.filter(
    (experiment) => experiment.wells.length > 0
  );
  const wellCount = experiments.reduce(
    (sum, experiment) => sum + experiment.wells.length,
    0
  );

  return (
    <ReportDataShell total={wellCount}>
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
  const available = seriesForFlavor(
    experiment.flavor,
    Object.keys(experiment.wells[0]?.series ?? {})
  );
  const [seriesId, setSeriesId] = useState<AuntySeriesId>(
    available.includes(experiment.primarySeries)
      ? experiment.primarySeries
      : (available[0] ?? experiment.primarySeries)
  );
  const [open, setOpen] = useState(false);

  return (
    <AuntyWellsProvider wells={experiment.wells.map((w) => w.well)}>
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
          onWellClick={() => setOpen(true)}
          seriesId={seriesId}
        />
        <AuntyWellDialog
          curvesFileId={curvesFileId}
          experiment={experiment}
          onOpenChange={setOpen}
          onSeriesChange={setSeriesId}
          open={open}
          seriesId={seriesId}
          seriesOptions={available}
        />
      </div>
    </AuntyWellsProvider>
  );
}
