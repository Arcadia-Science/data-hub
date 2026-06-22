"use client";

import { Fragment, useMemo, useState } from "react";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type PlateWellData = { well: string; value: unknown };

function parseWell(well: string): { row: number; col: number } | null {
  const match = well.match(/^([A-P])(\d{1,2})$/i);
  if (!match) {
    return null;
  }
  return {
    row: match[1].toUpperCase().charCodeAt(0) - 65,
    col: Number.parseInt(match[2], 10) - 1,
  };
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toPrecision(4).replace(/\.?0+$/, "");
  }
  return String(value);
}

// Plotly Plasma sequential colorscale stops as [R, G, B].
const PLASMA_STOPS: [number, number, number][] = [
  [13, 8, 135],
  [70, 3, 159],
  [114, 1, 168],
  [156, 23, 158],
  [189, 55, 134],
  [216, 87, 107],
  [237, 121, 83],
  [251, 159, 58],
  [253, 202, 38],
  [240, 249, 33],
];

function lerpRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Returns [background, foreground] CSS color strings.
function heatmapColor(
  value: number,
  min: number,
  max: number
): [string, string] {
  const n = PLASMA_STOPS.length - 1;
  if (max === min) {
    const mid = PLASMA_STOPS[Math.floor(n / 2)];
    return [`rgb(${mid[0]},${mid[1]},${mid[2]})`, "#fff"];
  }
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const scaled = t * n;
  const i = Math.min(Math.floor(scaled), n - 1);
  const [r, g, b] = lerpRgb(PLASMA_STOPS[i], PLASMA_STOPS[i + 1], scaled - i);
  // Perceived luminance (rec. 709) for text contrast.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fg = lum < 140 ? "#fff" : "hsl(330 30% 15%)";
  return [`rgb(${r},${g},${b})`, fg];
}

type PlateMapGridProps = {
  data: unknown;
  heatmap?: boolean;
  /** When heatmap is on, use this scale instead of inferring min/max from `data`. */
  heatmapRange?: { min: number; max: number };
  plateName?: string;
  wavelength?: string;
};

export function PlateMapGrid({
  data,
  heatmap = false,
  heatmapRange,
  plateName,
  wavelength,
}: PlateMapGridProps) {
  if (!Array.isArray(data)) {
    return null;
  }

  const wells = data as PlateWellData[];
  if (wells.length === 0) {
    return null;
  }

  let maxRow = 0;
  let maxCol = 0;
  const cellMap = new Map<string, unknown>();

  for (const w of wells) {
    const pos = parseWell(w.well);
    if (!pos) {
      continue;
    }
    if (pos.row > maxRow) {
      maxRow = pos.row;
    }
    if (pos.col > maxCol) {
      maxCol = pos.col;
    }
    cellMap.set(`${pos.row}-${pos.col}`, w.value);
  }

  const rows = maxRow + 1;
  const cols = maxCol + 1;

  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;
  if (heatmap) {
    if (heatmapRange) {
      vMin = heatmapRange.min;
      vMax = heatmapRange.max;
    } else {
      for (const v of cellMap.values()) {
        if (typeof v === "number") {
          if (v < vMin) {
            vMin = v;
          }
          if (v > vMax) {
            vMax = v;
          }
        }
      }
    }
  }
  const hasRange = isFinite(vMin) && isFinite(vMax);

  const rowLabels = Array.from({ length: rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: cols }, (_, i) => String(i + 1));

  return (
    <div className="flex w-fit flex-col gap-3">
      {(plateName || wavelength) && (
        <div className="flex items-baseline justify-between gap-4">
          <h4 className="font-medium font-mono text-foreground text-sm leading-snug">
            {plateName}
          </h4>
          {wavelength && (
            <span className="font-mono text-muted-foreground text-sm">
              {wavelength} nm
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <div
          className="inline-grid gap-0.5 text-center"
          style={{
            gridTemplateColumns: `2rem repeat(${cols}, minmax(3rem, 1fr))`,
          }}
        >
          {/* Column headers */}
          {colLabels.map((c, ci) => (
            <div
              className="py-1 font-medium text-muted-foreground text-xs"
              key={c}
              style={{ gridRow: 1, gridColumn: ci + 2 }}
            >
              {c}
            </div>
          ))}

          {/* Data rows */}
          {rowLabels.map((rowLabel, ri) => (
            <Fragment key={rowLabel}>
              <div
                className="flex items-center justify-center font-medium text-muted-foreground text-xs"
                style={{ gridRow: ri + 2, gridColumn: 1 }}
              >
                {rowLabel}
              </div>
              {colLabels.map((_, ci) => {
                const value = cellMap.get(`${ri}-${ci}`);
                const display = formatCellValue(value);
                const full =
                  value !== null && value !== undefined ? String(value) : "";
                const hasValue = display !== "";

                const useHeatmap =
                  heatmap && hasRange && typeof value === "number";
                const [bg, fg] = useHeatmap
                  ? heatmapColor(value, vMin, vMax)
                  : ["", ""];

                return (
                  <Tooltip key={`${ri}-${ci}`}>
                    <TooltipTrigger asChild>
                      <div
                        className={
                          useHeatmap
                            ? "flex aspect-square items-center justify-center rounded font-mono text-[10px] transition-colors"
                            : `flex aspect-square items-center justify-center rounded border font-mono text-xs ${
                                hasValue
                                  ? "border-border bg-muted/50"
                                  : "border-transparent"
                              }`
                        }
                        style={{
                          gridRow: ri + 2,
                          gridColumn: ci + 2,
                          ...(useHeatmap
                            ? { backgroundColor: bg, color: fg }
                            : {}),
                        }}
                      >
                        {display || "·"}
                      </div>
                    </TooltipTrigger>
                    {hasValue && (
                      <TooltipContent>
                        <span className="font-mono">
                          {rowLabel}
                          {ci + 1}: {full}
                        </span>
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {heatmap && hasRange && <PlasmaColorBar max={vMax} min={vMin} />}
    </div>
  );
}

function PlasmaColorBar({ min, max }: { min: number; max: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <span className="font-mono">{formatCellValue(min)}</span>
      <div
        className="h-3 flex-1 rounded-sm"
        style={{
          background:
            "linear-gradient(to right, rgb(13,8,135), rgb(189,55,134), rgb(253,202,38), rgb(240,249,33))",
        }}
      />
      <span className="font-mono">{formatCellValue(max)}</span>
    </div>
  );
}

function computeGlobalHeatmapRange(
  frames: PlateWellData[][]
): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    for (const w of frame) {
      if (typeof w.value === "number") {
        if (w.value < min) {
          min = w.value;
        }
        if (w.value > max) {
          max = w.value;
        }
      }
    }
  }
  if (!(isFinite(min) && isFinite(max))) {
    return;
  }
  return { min, max };
}

type KineticPlateMapWithTimeSliderProps = {
  timeLabels: string[];
  frames: PlateWellData[][];
  heatmap: boolean;
  plateName?: string;
  wavelength?: string;
};

/**
 * Plate map with a time index slider (for kinetic absorbance series).
 * Heatmap scale is global across all frames so colors stay comparable while scrubbing.
 */
export function KineticPlateMapWithTimeSlider({
  timeLabels,
  frames,
  heatmap,
  plateName,
  wavelength,
}: KineticPlateMapWithTimeSliderProps) {
  const [index, setIndex] = useState(0);
  const maxIdx = Math.max(0, frames.length - 1);
  const selectedIndex = Math.min(Math.max(0, index), maxIdx);

  const heatmapRange = useMemo(
    () => (heatmap ? computeGlobalHeatmapRange(frames) : undefined),
    [heatmap, frames]
  );

  if (frames.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <PlateMapGrid
        data={frames[selectedIndex]}
        heatmap={heatmap}
        heatmapRange={heatmapRange}
        plateName={plateName}
        wavelength={wavelength}
      />
      {frames.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span>Time</span>
            <span
              className="min-w-0 truncate font-mono text-foreground tabular-nums"
              title={timeLabels[selectedIndex] ?? ""}
            >
              {timeLabels[selectedIndex] ?? "—"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="w-10 shrink-0 truncate text-center font-mono text-[10px] text-muted-foreground"
              title={timeLabels[0]}
            >
              {timeLabels[0]}
            </span>
            <Slider
              aria-label="Select measurement time"
              className="flex-1 py-1"
              max={maxIdx}
              min={0}
              onValueChange={(v) => setIndex(v[0] ?? 0)}
              step={1}
              value={[selectedIndex]}
            />
            <span
              className="w-10 shrink-0 truncate text-center font-mono text-[10px] text-muted-foreground"
              title={timeLabels[maxIdx]}
            >
              {timeLabels[maxIdx]}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
