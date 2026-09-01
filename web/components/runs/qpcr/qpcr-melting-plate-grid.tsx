"use client";

import {
  type CSSProperties,
  Fragment,
  memo,
  useCallback,
  useMemo,
} from "react";
import { usePlateWellsActions } from "@/components/runs/plate-wells-provider";
import {
  QpcrMeltingSparkline,
  type QpcrMeltingSparklineLine,
} from "@/components/runs/qpcr/qpcr-melting-sparkline";
import { parseWellPosition, sparklineGeometry } from "@/lib/runs/plate-wells";
import {
  QPCR_MELTING_SERIES_META,
  type QpcrMeltingChannel,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

const NO_LINES: readonly QpcrMeltingSparklineLine[] = [];

function WellButton({
  lines,
  onSelect,
  style,
  well,
}: {
  lines: readonly QpcrMeltingSparklineLine[];
  onSelect: (well: string) => void;
  style?: CSSProperties;
  well: string;
}) {
  return (
    <button
      aria-label={`Open well ${well}`}
      className="flex aspect-square flex-col overflow-hidden rounded-md border bg-background text-left outline-none ring-offset-background transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onSelect(well)}
      style={style}
      type="button"
    >
      <span className="px-1 pt-0.5 font-mono text-[10px] text-muted-foreground leading-none">
        {well}
      </span>
      <div className="min-h-0 flex-1 px-0.5 pb-0.5">
        <QpcrMeltingSparkline lines={lines} />
      </div>
    </button>
  );
}

// Memoized so opening or closing the well dialog does not re-render up to 384
// sparklines behind it.
export const QpcrMeltingPlateGrid = memo(function QpcrMeltingPlateGrid({
  channel,
  onWellClick,
  seriesIds,
}: {
  channel: QpcrMeltingChannel;
  onWellClick: (well: string) => void;
  seriesIds: readonly QpcrMeltingSeriesId[];
}) {
  const { selectWell } = usePlateWellsActions();

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
    const byPos = new Map<string, (typeof channel.wells)[number]>();
    for (const well of channel.wells) {
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
  }, [channel.wells]);

  // Built per well rather than per render so `WellButton`'s memo holds across
  // a dialog open/close; only a series or channel change rebuilds them.
  const linesByWell = useMemo(() => {
    const map = new Map<string, QpcrMeltingSparklineLine[]>();
    for (const well of channel.wells) {
      map.set(
        well.well,
        seriesIds.map((id) => ({
          meta: QPCR_MELTING_SERIES_META[id],
          geometry: sparklineGeometry(well.series[id] ?? []),
        }))
      );
    }
    return map;
  }, [channel.wells, seriesIds]);

  if (layout.byPos.size === 0) {
    return null;
  }

  const rowLabels = Array.from({ length: layout.rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: layout.cols }, (_, i) =>
    String(i + 1)
  );

  return (
    <div className="min-w-0 overflow-x-auto overscroll-x-contain">
      <div
        className="grid w-full gap-1.5"
        style={{
          gridTemplateColumns: `1.5rem repeat(${layout.cols}, minmax(0, 1fr))`,
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
                  key={label}
                  lines={linesByWell.get(well.well) ?? NO_LINES}
                  onSelect={openWell}
                  style={style}
                  well={well.well}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
});
