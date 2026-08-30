"use client";

import { Fragment, useMemo, useState } from "react";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PlateWellData {
  value: unknown;
  well: string;
}

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

/** 96-well is 8×12. Denser formats (384-well) use a full-width scrollport. */
const COMPACT_PLATE_MAX_COLS = 12;

/** Floor so 24-column plates stay readable instead of shrinking to fit. */
const WIDE_PLATE_WELL_TRACK = "4rem";

// Sized against the plate box, not the viewport, because the same map renders
// in a wide run page and a narrow MCP iframe. Per-cell sizing would be cyclic.
const PLATE_META_TEXT = "text-[length:clamp(0.75rem,2.2cqw,0.875rem)]";
const PLATE_AXIS_TEXT = "text-[length:clamp(0.5rem,1.8cqw,0.875rem)]";
const PLATE_SCALE_TEXT = "text-[length:clamp(0.4375rem,1.6cqw,0.75rem)]";
const PLATE_SLIDER_TEXT = "text-[length:clamp(0.625rem,1.8cqw,0.75rem)]";
const WELL_VALUE_TEXT =
  "text-[length:clamp(0.5rem,1.6cqw,0.75rem)] leading-none";

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

interface PlateMapGridProps {
  className?: string;
  data: unknown;
  heatmap?: boolean;
  /** When heatmap is on, use this scale instead of inferring min/max from `data`. */
  heatmapRange?: { min: number; max: number };
  plateName?: string;
  wavelength?: string;
}

export function PlateMapGrid({
  className,
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
  const hasRange = Number.isFinite(vMin) && Number.isFinite(vMax);

  const rowLabels = Array.from({ length: rows }, (_, i) =>
    String.fromCharCode(65 + i)
  );
  const colLabels = Array.from({ length: cols }, (_, i) => String(i + 1));
  const wide = cols > COMPACT_PLATE_MAX_COLS;
  const wellTrack = wide ? WIDE_PLATE_WELL_TRACK : "minmax(0, 1fr)";

  return (
    <div
      className={cn("@container flex w-full min-w-0 flex-col gap-3", className)}
    >
      {(plateName || wavelength) && (
        <div className="flex min-w-0 items-baseline justify-between gap-4">
          <h4
            className={cn(
              "min-w-0 text-pretty font-medium font-mono text-foreground leading-snug",
              PLATE_META_TEXT
            )}
          >
            {plateName}
          </h4>
          {wavelength && (
            <span
              className={cn(
                "shrink-0 font-mono text-muted-foreground",
                PLATE_META_TEXT
              )}
            >
              {wavelength} nm
            </span>
          )}
        </div>
      )}
      <div
        aria-label={plateName ? `${plateName} plate map` : "Plate map"}
        className={cn(
          "w-full min-w-0 overflow-x-auto overscroll-x-contain",
          wide &&
            "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        )}
        role="region"
        tabIndex={wide ? 0 : undefined}
      >
        <div
          className={cn(
            "grid gap-0.5 text-center",
            wide ? "w-max min-w-full" : "w-full"
          )}
          style={{
            // Extra column for the vertical color bar, sized to its labels.
            gridTemplateColumns:
              heatmap && hasRange
                ? `2rem repeat(${cols}, ${wellTrack}) auto`
                : `2rem repeat(${cols}, ${wellTrack})`,
          }}
        >
          {/* Column headers */}
          {colLabels.map((c, ci) => (
            <div
              className={cn(
                "py-1 font-medium text-muted-foreground",
                PLATE_AXIS_TEXT
              )}
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
                className={cn(
                  "flex items-center justify-center font-medium text-muted-foreground",
                  PLATE_AXIS_TEXT
                )}
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
                        className={cn(
                          "flex aspect-square w-full min-w-0 items-center justify-center overflow-hidden rounded font-mono tabular-nums",
                          WELL_VALUE_TEXT,
                          useHeatmap
                            ? "transition-colors"
                            : hasValue
                              ? "border border-border bg-muted/50"
                              : "border border-transparent"
                        )}
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

          {/*
            Color bar shares the plate grid so the rectangle aligns with wells
            A…H; max/min sit in the header row and a trailing row.
          */}
          {heatmap && hasRange && (
            <>
              <div
                className={cn(
                  "ml-4 flex items-end justify-center pb-0.5 text-muted-foreground",
                  PLATE_SCALE_TEXT
                )}
                style={{ gridRow: 1, gridColumn: cols + 3 }}
              >
                <span className="font-mono tabular-nums">
                  {formatCellValue(vMax)}
                </span>
              </div>
              <div
                className="ml-4 w-4 self-stretch overflow-hidden rounded-md"
                style={{
                  gridRow: `2 / ${rows + 2}`,
                  gridColumn: cols + 3,
                  background:
                    "linear-gradient(to top, rgb(13,8,135), rgb(189,55,134), rgb(253,202,38), rgb(240,249,33))",
                }}
              />
              <div
                className={cn(
                  "ml-4 flex items-start justify-center pt-0.5 text-muted-foreground",
                  PLATE_SCALE_TEXT
                )}
                style={{ gridRow: rows + 2, gridColumn: cols + 3 }}
              >
                <span className="font-mono tabular-nums">
                  {formatCellValue(vMin)}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
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
  if (!(Number.isFinite(min) && Number.isFinite(max))) {
    return;
  }
  return { min, max };
}

interface PlateMapWithIndexSliderProps {
  frameLabels: string[];
  frames: PlateWellData[][];
  heatmap: boolean;
  plateName?: string;
  sliderAxis?: "time" | "wavelength";
  wavelength?: string;
}

/**
 * Plate map with an index slider (kinetic time-points or Spectrum
 * wavelengths). Heatmap scale is global across all frames so colors stay
 * comparable while scrubbing.
 */
export function PlateMapWithIndexSlider({
  frameLabels,
  frames,
  heatmap,
  plateName,
  wavelength,
  sliderAxis = "time",
}: PlateMapWithIndexSliderProps) {
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

  // Thumb centers track from 0–100%; avoid div-by-zero on a single frame.
  const thumbPercent = maxIdx === 0 ? 0 : (selectedIndex / maxIdx) * 100;
  const displayWavelength =
    sliderAxis === "wavelength"
      ? (frameLabels[selectedIndex] ?? wavelength)
      : wavelength;

  return (
    <div className="@container flex w-full min-w-0 flex-col gap-3">
      <PlateMapGrid
        className="w-full"
        data={frames[selectedIndex]}
        heatmap={heatmap}
        heatmapRange={heatmapRange}
        plateName={plateName}
        wavelength={displayWavelength}
      />
      {frames.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <span
            className={cn(
              "shrink-0 font-mono text-muted-foreground tabular-nums",
              PLATE_SLIDER_TEXT
            )}
          >
            {frameLabels[0]}
          </span>
          <div className="relative min-w-0 flex-1">
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute bottom-full z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-1.5 py-0.5 font-mono text-background tabular-nums",
                PLATE_SLIDER_TEXT
              )}
              style={{ left: `${thumbPercent}%` }}
            >
              {frameLabels[selectedIndex] ?? "—"}
            </div>
            <Slider
              aria-label={
                sliderAxis === "wavelength"
                  ? "Select wavelength"
                  : "Select measurement time"
              }
              className="w-full py-1"
              max={maxIdx}
              min={0}
              onValueChange={(v) => setIndex(v[0] ?? 0)}
              step={1}
              value={[selectedIndex]}
            />
          </div>
          <span
            className={cn(
              "shrink-0 font-mono text-muted-foreground tabular-nums",
              PLATE_SLIDER_TEXT
            )}
          >
            {frameLabels[maxIdx]}
          </span>
        </div>
      )}
    </div>
  );
}
