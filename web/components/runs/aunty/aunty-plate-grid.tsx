"use client";

import { Fragment, useMemo } from "react";
import {
  AuntySparkline,
  sparklineGeometry,
} from "@/components/runs/aunty/aunty-sparkline";
import { useAuntyWells } from "@/components/runs/aunty/aunty-wells-provider";
import {
  AUNTY_SERIES_META,
  type AuntyExperiment,
  type AuntySeriesId,
  parseWellPosition,
  tmMarkerValue,
} from "@/lib/runs/aunty";
import { cn } from "@/lib/utils";

const COMPACT_PLATE_MAX_COLS = 12;

export function AuntyPlateGrid({
  experiment,
  onWellClick,
  seriesId,
}: {
  experiment: AuntyExperiment;
  onWellClick: (well: string) => void;
  seriesId: AuntySeriesId;
}) {
  const { selectWell } = useAuntyWells();
  const meta = AUNTY_SERIES_META[seriesId];

  const layout = useMemo(() => {
    let maxRow = 0;
    let maxCol = 0;
    const byPos = new Map<string, (typeof experiment.wells)[number]>();
    for (const well of experiment.wells) {
      const pos = parseWellPosition(well.well);
      if (!pos) {
        continue;
      }
      if (pos.row > maxRow) {
        maxRow = pos.row;
      }
      if (pos.col > maxCol) {
        maxCol = pos.col;
      }
      byPos.set(`${pos.row}-${pos.col}`, well);
    }
    return { rows: maxRow + 1, cols: maxCol + 1, byPos };
  }, [experiment.wells]);

  const geometries = useMemo(() => {
    const map = new Map<string, ReturnType<typeof sparklineGeometry>>();
    for (const well of experiment.wells) {
      const points = well.series[seriesId] ?? [];
      const marker =
        meta.markerKey === "tm1" ? tmMarkerValue(well.values) : null;
      map.set(well.well, sparklineGeometry(points, marker));
    }
    return map;
  }, [experiment.wells, meta.markerKey, seriesId]);

  if (layout.rows === 0 || layout.cols === 0) {
    return null;
  }

  const rowLabels = Array.from({ length: layout.rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: layout.cols }, (_, i) =>
    String(i + 1)
  );
  const wide = layout.cols > COMPACT_PLATE_MAX_COLS;
  const wellTrack = wide ? "4rem" : "minmax(0, 1fr)";

  return (
    <div
      aria-label={`${experiment.fileName} plate`}
      className={cn(
        "min-w-0 overflow-x-auto overscroll-x-contain",
        wide &&
          "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      )}
      role="region"
      tabIndex={wide ? 0 : undefined}
    >
      <div
        className={cn("grid gap-1.5", wide ? "w-max min-w-full" : "w-full")}
        style={{
          gridTemplateColumns: `1.5rem repeat(${layout.cols}, ${wellTrack})`,
        }}
      >
        {colLabels.map((c, ci) => (
          <div
            className="py-0.5 text-center font-medium text-muted-foreground text-xs"
            key={c}
            style={{ gridRow: 1, gridColumn: ci + 2 }}
          >
            {c}
          </div>
        ))}
        {rowLabels.map((rowLabel, ri) => (
          <Fragment key={rowLabel}>
            <div
              className="flex items-center justify-center font-medium text-muted-foreground text-xs"
              style={{ gridRow: ri + 2, gridColumn: 1 }}
            >
              {rowLabel}
            </div>
            {colLabels.map((_, ci) => {
              const well = layout.byPos.get(`${ri}-${ci}`);
              const label = `${rowLabel}${ci + 1}`;
              if (!well) {
                return (
                  <div
                    className="aspect-square rounded-md border border-transparent"
                    key={label}
                    style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
                  />
                );
              }
              const geometry = geometries.get(well.well);
              return (
                <button
                  aria-label={`Open well ${well.well}`}
                  className="flex aspect-square flex-col overflow-hidden rounded-md border bg-background text-left outline-none ring-offset-background transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
                  key={label}
                  onClick={() => {
                    selectWell(well.well);
                    onWellClick(well.well);
                  }}
                  style={{ gridRow: ri + 2, gridColumn: ci + 2 }}
                  type="button"
                >
                  <span className="px-1 pt-0.5 font-mono text-[10px] text-muted-foreground leading-none">
                    {well.well}
                  </span>
                  <div className="min-h-0 flex-1 px-0.5 pb-0.5">
                    <AuntySparkline geometry={geometry} meta={meta} />
                  </div>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
