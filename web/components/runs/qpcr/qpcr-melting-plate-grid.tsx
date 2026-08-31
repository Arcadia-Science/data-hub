"use client";

import { type CSSProperties, Fragment, memo, useMemo } from "react";
import { QpcrMeltingSparkline } from "@/components/runs/qpcr/qpcr-melting-sparkline";
import {
  parseWellPosition,
  type SparklineGeometry,
  sparklineGeometry,
} from "@/lib/runs/aunty";
import type { QpcrMeltingChannel } from "@/lib/runs/qpcr-melting";
import { cn } from "@/lib/utils";

function WellTile({
  geometry,
  label,
  style,
}: {
  geometry?: SparklineGeometry;
  label: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="flex aspect-square flex-col overflow-hidden rounded-md border bg-background text-left"
      style={style}
    >
      <span className="px-1 pt-0.5 font-mono text-[10px] text-muted-foreground leading-none">
        {label}
      </span>
      <div className="min-h-0 flex-1 px-0.5 pb-0.5">
        <QpcrMeltingSparkline geometry={geometry} label={`${label} −dF%/dT`} />
      </div>
    </div>
  );
}

export const QpcrMeltingPlateGrid = memo(function QpcrMeltingPlateGrid({
  channel,
}: {
  channel: QpcrMeltingChannel;
}) {
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

  const geometries = useMemo(() => {
    const map = new Map<string, SparklineGeometry>();
    for (const well of channel.wells) {
      map.set(well.well, sparklineGeometry(well.points));
    }
    return map;
  }, [channel.wells]);

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
    <div className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0 overflow-x-auto overscroll-x-contain">
        <div
          className={cn("grid w-full gap-1.5")}
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
                  <WellTile
                    geometry={geometries.get(well.well)}
                    key={label}
                    label={label}
                    style={style}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
});
