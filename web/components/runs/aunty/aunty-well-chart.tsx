"use client";

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
  type AuntyFlavor,
  type AuntyPoint,
  type AuntySeriesId,
  type AuntyWell,
  seriesMetaFor,
  TM_MARKER_COLOR,
  tmMarkerValue,
} from "@/lib/runs/aunty";

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

export function AuntyWellChart({
  fileName,
  flavor,
  points,
  seriesId,
  well,
}: {
  fileName: string;
  flavor: AuntyFlavor;
  points: AuntyPoint[];
  seriesId: AuntySeriesId;
  well: AuntyWell;
}) {
  const meta = seriesMetaFor(flavor, seriesId);
  const marker = meta.markerKey === "tm1" ? tmMarkerValue(well.values) : null;
  const last = points.at(-1);
  const chartConfig = {
    y: { label: meta.label, color: meta.color },
  } satisfies ChartConfig;

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer className="aspect-auto h-80 w-full" config={chartConfig}>
        <LineChart
          data={points}
          margin={{ top: 20, right: 16, bottom: 28, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="x"
            domain={["dataMin", "dataMax"]}
            label={{
              value: meta.xLabel,
              position: "insideBottom",
              offset: -16,
              style: {
                fontSize: 11,
                fill: "var(--color-muted-foreground)",
              },
            }}
            tickFormatter={formatTick}
            tickLine={false}
            tickMargin={8}
            type="number"
          />
          {/* Fit to the series; Recharts otherwise pins the floor at 0. */}
          <YAxis
            axisLine={false}
            dataKey="y"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatTick}
            tickLine={false}
            tickMargin={8}
            type="number"
            width={64}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) =>
                  typeof label === "number"
                    ? `${meta.xLabel}: ${formatTick(label)}`
                    : String(label)
                }
              />
            }
          />
          {marker != null && (
            <ReferenceLine
              ifOverflow="extendDomain"
              label={{
                value: `Tm1: ${marker.toFixed(1)}`,
                fill: TM_MARKER_COLOR,
                fontSize: 11,
                position: "top",
              }}
              stroke={TM_MARKER_COLOR}
              strokeDasharray="4 4"
              x={marker}
            />
          )}
          <Line
            dataKey="y"
            dot={false}
            isAnimationActive={false}
            name={meta.label}
            stroke={meta.color}
            strokeWidth={1.75}
          />
        </LineChart>
      </ChartContainer>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {marker != null && (
          <LegendItem
            color={TM_MARKER_COLOR}
            label={`${fileName} Tm1 (\u00b0C)`}
            value={marker}
          />
        )}
        {last && (
          <LegendItem
            color={meta.color}
            label={`${fileName} ${meta.label}`}
            value={last.y}
          />
        )}
      </div>
    </div>
  );
}

function LegendItem({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="size-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{formatTick(value)}</span>
    </div>
  );
}
