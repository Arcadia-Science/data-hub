"use client";

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  QPCR_MELTING_SERIES_META,
  QPCR_MELTING_X_LABEL,
  type QpcrMeltingPoint,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

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

export function QpcrMeltingWellChart({
  points,
  seriesId,
}: {
  points: QpcrMeltingPoint[];
  seriesId: QpcrMeltingSeriesId;
}) {
  const meta = QPCR_MELTING_SERIES_META[seriesId];
  const chartConfig = {
    y: { label: meta.label, color: meta.color },
  } satisfies ChartConfig;

  return (
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
        {/* Fit to the series; Recharts otherwise pins the floor at 0, which
            hides the baseline wobble either side of a melt peak. */}
        <YAxis
          axisLine={false}
          dataKey="y"
          domain={["dataMin", "dataMax"]}
          label={{
            value: meta.yLabel,
            angle: -90,
            position: "insideLeft",
            style: {
              fontSize: 11,
              fill: "var(--color-muted-foreground)",
              textAnchor: "middle",
            },
          }}
          tickFormatter={formatTick}
          tickLine={false}
          tickMargin={8}
          type="number"
          width={72}
        />
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
  );
}
