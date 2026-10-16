"use client";

import { memo, useCallback, useMemo } from "react";
import { AuntySparkline } from "@/components/runs/aunty/aunty-sparkline";
import { PlateGrid } from "@/components/runs/plate-grid";
import { usePlateWellsActions } from "@/components/runs/plate-wells-provider";
import {
  AUNTY_SERIES_META,
  type AuntyExperiment,
  type AuntySeriesId,
  type AuntyWell,
  tmMarkerValue,
  wellTileValue,
} from "@/lib/runs/aunty";
import {
  type SparklineGeometry,
  sparklineGeometry,
} from "@/lib/runs/plate-wells";

// Memoized so opening or closing the well dialog does not re-render up to 384
// sparklines behind it.
export const AuntyPlateGrid = memo(function AuntyPlateGrid({
  experiment,
  onWellClick,
  seriesId,
}: {
  experiment: AuntyExperiment;
  onWellClick: (well: string) => void;
  seriesId: AuntySeriesId;
}) {
  const { selectWell } = usePlateWellsActions();
  const meta = AUNTY_SERIES_META[seriesId];

  const openWell = useCallback(
    (well: string) => {
      selectWell(well);
      onWellClick(well);
    },
    [onWellClick, selectWell]
  );

  const geometries = useMemo(() => {
    const map = new Map<string, SparklineGeometry>();
    for (const well of experiment.wells) {
      const points = well.series[seriesId] ?? [];
      const marker =
        meta.markerKey === "tm1" ? tmMarkerValue(well.values) : null;
      map.set(well.well, sparklineGeometry(points, marker));
    }
    return map;
  }, [experiment.wells, meta.markerKey, seriesId]);

  const renderTile = useCallback(
    (well: AuntyWell) => {
      const geometry = geometries.get(well.well);
      const summary = wellTileValue(experiment.flavor, well.values);
      return (
        <>
          <span className="px-1 pt-0.5 font-mono text-[10px] text-muted-foreground leading-none">
            {well.well}
          </span>
          <div className="min-h-0 flex-1 px-0.5 pb-0.5">
            {geometry?.d ? (
              <AuntySparkline geometry={geometry} meta={meta} />
            ) : summary ? (
              <span className="flex h-full items-center justify-center font-mono text-[10px] tabular-nums leading-none">
                {summary}
              </span>
            ) : (
              <div className="h-full min-h-12 w-full" />
            )}
          </div>
        </>
      );
    },
    [experiment.flavor, geometries, meta]
  );

  return (
    <PlateGrid
      ariaLabel={`${experiment.fileName} plate`}
      onSelectWell={openWell}
      renderTile={renderTile}
      wells={experiment.wells}
    />
  );
});
