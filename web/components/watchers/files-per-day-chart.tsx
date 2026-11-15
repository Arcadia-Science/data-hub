"use client";

import { Bar, BarChart, Cell, LabelList, XAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { pluralize } from "@/lib/watchers/phrases";
import { shortDayLabel } from "@/lib/watchers/range";

// The bars take the container's text color, so the theme's blue comes from a
// Tailwind class and follows dark mode.
const chartConfig = {
  files: { label: "Files uploaded" },
} satisfies ChartConfig;

/**
 * Files uploaded per day, one bar a day. A day with none keeps a thin stub, so
 * the axis still counts it.
 */
export function FilesPerDayChart({
  days,
}: {
  days: { date: string; files: number }[];
}) {
  const data = days.map((day) => ({
    date: day.date,
    label: shortDayLabel(day.date),
    files: day.files,
  }));
  const summary = data
    .map((day) => `${day.label}: ${pluralize(day.files, "file")}`)
    .join(". ");

  return (
    <>
      <p className="sr-only">{summary}.</p>
      {/* The chart is hidden from assistive technology, and its summary above is
          what it hears: recharts' own accessibility layer adds a second
          focusable element with a garbled name. */}
      <ChartContainer
        aria-hidden="true"
        className="aspect-auto h-52 w-full text-blue-500 dark:text-blue-400"
        config={chartConfig}
      >
        <BarChart
          accessibilityLayer={false}
          data={data}
          margin={{ top: 20, right: 4, bottom: 0, left: 4 }}
        >
          <XAxis
            axisLine
            dataKey="label"
            interval={data.length > 10 ? "preserveStartEnd" : 0}
            minTickGap={12}
            tickLine={false}
            tickMargin={8}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => (
                  <span className="font-medium">
                    {pluralize(Number(value), "file")}
                  </span>
                )}
                hideIndicator
              />
            }
            cursor={false}
          />
          {/* No animation: recharts doesn't follow the reduced-motion setting. */}
          <Bar
            dataKey="files"
            isAnimationActive={false}
            maxBarSize={56}
            minPointSize={2}
            radius={[6, 6, 0, 0]}
          >
            {data.map((day) => (
              <Cell
                fill={day.files > 0 ? "currentColor" : "var(--border)"}
                key={day.date}
              />
            ))}
            <LabelList
              className="fill-foreground font-medium"
              dataKey="files"
              fontSize={12}
              formatter={(value: unknown) =>
                Number(value) > 0 ? String(value) : ""
              }
              position="top"
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </>
  );
}
