"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  meltPeakTemperature,
  QPCR_MELTING_PEAK_COLOR,
  QPCR_MELTING_SERIES_META,
  QPCR_MELTING_X_LABEL,
  type QpcrMeltingSeriesId,
  type QpcrMeltingWellCurves,
} from "@/lib/runs/qpcr-melting";

const CHART_CONFIG = {
  derivative: {
    label: QPCR_MELTING_SERIES_META.derivative.label,
    color: QPCR_MELTING_SERIES_META.derivative.color,
  },
  fluorescence: {
    label: QPCR_MELTING_SERIES_META.fluorescence.label,
    color: QPCR_MELTING_SERIES_META.fluorescence.color,
  },
} satisfies ChartConfig;

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  if (abs >= 10) {
    return value.toFixed(0);
  }
  return value.toFixed(2);
}

// Both series are read off the same temperature rows, so they collapse into
// one row per temperature — the shape Recharts wants for a multi-line chart.
function mergeRows(
  curves: Partial<QpcrMeltingWellCurves>,
  seriesIds: readonly QpcrMeltingSeriesId[]
): Record<string, number>[] {
  const byX = new Map<number, Record<string, number>>();
  for (const id of seriesIds) {
    for (const point of curves[id] ?? []) {
      const row = byX.get(point.x);
      if (row) {
        row[id] = point.y;
      } else {
        byX.set(point.x, { x: point.x, [id]: point.y });
      }
    }
  }
  return [...byX.values()].sort((a, b) => a.x - b.x);
}

export function QpcrMeltingWellChart({
  curves,
  seriesIds,
}: {
  curves: Partial<QpcrMeltingWellCurves>;
  seriesIds: readonly QpcrMeltingSeriesId[];
}) {
  const rows = useMemo(() => mergeRows(curves, seriesIds), [curves, seriesIds]);
  // Tied to the derivative being on screen, so hiding it hides everything
  // derived from it rather than leaving an unexplained line behind.
  const peakX = useMemo(
    () =>
      seriesIds.includes("derivative")
        ? meltPeakTemperature(curves.derivative)
        : null,
    [curves.derivative, seriesIds]
  );

  return (
    <ChartContainer className="aspect-auto h-80 w-full" config={CHART_CONFIG}>
      <LineChart
        data={rows}
        margin={{ top: 20, right: 8, bottom: 28, left: 8 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          vertical={false}
          yAxisId={seriesIds[0]}
        />
        <XAxis
          axisLine={false}
          dataKey="x"
          domain={["dataMin", "dataMax"]}
          label={{
            value: QPCR_MELTING_X_LABEL,
            position: "insideBottom",
            offset: -16,
            style: { fontSize: 11, fill: "var(--color-muted-foreground)" },
          }}
          tickFormatter={formatTick}
          tickLine={false}
          tickMargin={8}
          type="number"
        />
        {/* One axis per visible series. They share no units — a derivative in
            %/°C against a percentage of peak fluorescence — so each is fitted
            to its own data and tinted to match its line. */}
        {seriesIds.map((id, index) => {
          const meta = QPCR_MELTING_SERIES_META[id];
          const onLeft = index === 0;
          return (
            <YAxis
              axisLine={false}
              dataKey={id}
              domain={["dataMin", "dataMax"]}
              key={id}
              label={{
                value: meta.yLabel,
                angle: onLeft ? -90 : 90,
                position: onLeft ? "insideLeft" : "insideRight",
                style: { fontSize: 11, fill: meta.color, textAnchor: "middle" },
              }}
              orientation={onLeft ? "left" : "right"}
              tick={{ fill: meta.color, fontSize: 12 }}
              tickFormatter={formatTick}
              tickLine={false}
              tickMargin={8}
              type="number"
              width={76}
              yAxisId={id}
            />
          );
        })}
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) =>
                typeof label === "number"
                  ? `${QPCR_MELTING_X_LABEL}: ${formatTick(label)}`
                  : String(label)
              }
            />
          }
        />
        {peakX !== null && (
          <ReferenceLine
            ifOverflow="extendDomain"
            label={{
              value: `Tm ${peakX.toFixed(1)} \u00b0C`,
              fill: QPCR_MELTING_PEAK_COLOR,
              fontSize: 11,
              position: "top",
            }}
            stroke={QPCR_MELTING_PEAK_COLOR}
            strokeDasharray="4 4"
            x={peakX}
            yAxisId={seriesIds[0]}
          />
        )}
        {seriesIds.map((id) => (
          <Line
            connectNulls
            dataKey={id}
            dot={false}
            isAnimationActive={false}
            key={id}
            name={QPCR_MELTING_SERIES_META[id].label}
            stroke={QPCR_MELTING_SERIES_META[id].color}
            strokeWidth={1.75}
            yAxisId={id}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}
