"use client";

import {
  type CSSProperties,
  Fragment,
  memo,
  useCallback,
  useMemo,
} from "react";
import { AuntySparkline } from "@/components/runs/aunty/aunty-sparkline";
import { usePlateWellsActions } from "@/components/runs/plate-wells-provider";
import {
  AUNTY_SERIES_META,
  type AuntyExperiment,
  type AuntySeriesId,
  type AuntySeriesMeta,
  type AuntyWell,
  tmMarkerValue,
  wellTileValue,
} from "@/lib/runs/aunty";
import {
  parseWellPosition,
  type SparklineGeometry,
  sparklineGeometry,
} from "@/lib/runs/plate-wells";
import { cn } from "@/lib/utils";

const COMPACT_PLATE_MAX_COLS = 12;

function WellButton({
  className,
  geometry,
  meta,
  onSelect,
  style,
  summary,
  well,
}: {
  className?: string;
  geometry?: SparklineGeometry;
  meta: AuntySeriesMeta;
  onSelect: (well: string) => void;
  style?: CSSProperties;
  summary: string | null;
  well: AuntyWell;
}) {
  return (
    <button
      aria-label={`Open well ${well.well}`}
      className={cn(
        "flex aspect-square flex-col overflow-hidden rounded-md border bg-background text-left outline-none ring-offset-background transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      onClick={() => onSelect(well.well)}
      style={style}
      type="button"
    >
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
    </button>
  );
}

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

  const layout = useMemo(() => {
    let maxRow = 0;
    let maxCol = 0;
    const byPos = new Map<string, AuntyWell>();
    const unplaced: AuntyWell[] = [];
    for (const well of experiment.wells) {
      const pos = parseWellPosition(well.well);
      if (!pos) {
        unplaced.push(well);
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
    return { rows: maxRow + 1, cols: maxCol + 1, byPos, unplaced };
  }, [experiment.wells]);

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

  if (layout.byPos.size === 0 && layout.unplaced.length === 0) {
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
    <div className="flex w-full min-w-0 flex-col gap-3">
      {layout.byPos.size > 0 && (
        <div
          aria-label={`${experiment.fileName} plate`}
          className={cn(
            "w-full min-w-0 overflow-x-auto overscroll-x-contain",
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
                  const style = { gridRow: ri + 2, gridColumn: ci + 2 };
                  if (!well) {
                    return (
                      <div
                        className="aspect-square rounded-md border border-transparent"
                        key={label}
                        style={style}
                      />
                    );
                  }
                  return (
                    <WellButton
                      geometry={geometries.get(well.well)}
                      key={label}
                      meta={meta}
                      onSelect={openWell}
                      style={style}
                      summary={wellTileValue(experiment.flavor, well.values)}
                      well={well}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      )}
      {layout.unplaced.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">
            Wells with labels outside the plate layout
          </span>
          <div className="flex flex-wrap gap-1.5">
            {layout.unplaced.map((well) => (
              <WellButton
                className="w-16"
                geometry={geometries.get(well.well)}
                key={well.well}
                meta={meta}
                onSelect={openWell}
                summary={wellTileValue(experiment.flavor, well.values)}
                well={well}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
