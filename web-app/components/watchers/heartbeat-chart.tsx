"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WatcherHeartbeatRow } from "@/lib/api/watchers";
import { cn } from "@/lib/utils";
import { HeartPulse } from "lucide-react";
import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

const chartConfig = {
  files: { label: "Files", color: "var(--color-primary)" },
  runs: { label: "Runs", color: "var(--color-chart-2)" },
  errors: { label: "Errors", color: "var(--color-destructive)" },
} satisfies ChartConfig;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const STATUS_COLORS: Record<string, string> = {
  watching: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
};

const BUCKET_COUNT = 48;

type Bucket = {
  key: number;
  className: string;
  label: string;
  startTime: Date;
  endTime: Date;
  heartbeatCount: number;
};

function buildBuckets(heartbeats: WatcherHeartbeatRow[]): {
  buckets: Bucket[];
  windowStart: Date;
  windowEnd: Date;
} {
  const now = Date.now();
  const windowEnd = new Date(now);
  const windowStart = new Date(now - DAY_MS);
  const startMs = windowStart.getTime();
  const bucketMs = DAY_MS / BUCKET_COUNT;

  const statuses: (string | null)[] = new Array(BUCKET_COUNT).fill(null);
  const counts: number[] = new Array(BUCKET_COUNT).fill(0);

  for (const hb of heartbeats) {
    const idx = Math.min(
      Math.floor((hb.timestamp.getTime() - startMs) / bucketMs),
      BUCKET_COUNT - 1
    );
    if (idx < 0) continue;

    counts[idx]++;
    const prev = statuses[idx];
    if (prev === null || prev === "watching") {
      statuses[idx] = hb.status;
    }
  }

  const STATUS_LABELS: Record<string, string> = {
    watching: "Operational",
    stopped: "Stopped",
  };

  const buckets: Bucket[] = statuses.map((status, i) => ({
    key: i,
    className:
      status === null ? "bg-muted" : (STATUS_COLORS[status] ?? "bg-amber-500"),
    label: status === null ? "No data" : (STATUS_LABELS[status] ?? status),
    startTime: new Date(startMs + i * bucketMs),
    endTime: new Date(startMs + (i + 1) * bucketMs),
    heartbeatCount: counts[i],
  }));

  return { buckets, windowStart, windowEnd };
}

function StatusStrip({ heartbeats }: { heartbeats: WatcherHeartbeatRow[] }) {
  const { buckets, windowStart, windowEnd } = useMemo(
    () => buildBuckets(heartbeats),
    [heartbeats]
  );

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Connectivity</span>
      <div className="flex h-6 w-full items-stretch gap-0.5">
        {buckets.map((bucket) => (
          <Tooltip key={bucket.key} delayDuration={0}>
            <TooltipTrigger asChild>
              <div className={cn("flex-1 rounded-sm", bucket.className)} />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p className="font-medium">{bucket.label}</p>
              <p className="text-muted-foreground">
                {formatTime(bucket.startTime)} – {formatTime(bucket.endTime)}
              </p>
              <p className="text-muted-foreground">
                {bucket.heartbeatCount} heartbeat
                {bucket.heartbeatCount !== 1 && "s"}
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatTime(windowStart)}</span>
        <span>{formatTime(windowEnd)}</span>
      </div>
    </div>
  );
}

export function HeartbeatChart({
  heartbeats,
}: {
  heartbeats: WatcherHeartbeatRow[];
}) {
  if (heartbeats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <HeartPulse className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No heartbeats in this time range.
        </p>
      </div>
    );
  }

  const data = heartbeats.map((hb) => ({
    timestamp: hb.timestamp.getTime(),
    files: hb.filesUploadedSinceLast ?? 0,
    runs: hb.runsReportedSinceLast ?? 0,
    errors: hb.errorsSinceLast ?? 0,
  }));

  return (
    <div>
      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id="fillFiles" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-files)"
                stopOpacity={0.3}
              />
              <stop
                offset="100%"
                stopColor="var(--color-files)"
                stopOpacity={0.05}
              />
            </linearGradient>
            <linearGradient id="fillRuns" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-runs)"
                stopOpacity={0.3}
              />
              <stop
                offset="100%"
                stopColor="var(--color-runs)"
                stopOpacity={0.05}
              />
            </linearGradient>
            <linearGradient id="fillErrors" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-errors)"
                stopOpacity={0.3}
              />
              <stop
                offset="100%"
                stopColor="var(--color-errors)"
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => formatTime(new Date(v))}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={40}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={32}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const ts = payload?.[0]?.payload?.timestamp;
                  return ts
                    ? new Date(ts).toLocaleString("en-US", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })
                    : "";
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            dataKey="errors"
            type="monotone"
            stackId="1"
            stroke="var(--color-errors)"
            fill="url(#fillErrors)"
            strokeWidth={1.5}
          />
          <Area
            dataKey="files"
            type="monotone"
            stackId="1"
            stroke="var(--color-files)"
            fill="url(#fillFiles)"
            strokeWidth={1.5}
          />
          <Area
            dataKey="runs"
            type="monotone"
            stackId="1"
            stroke="var(--color-runs)"
            fill="url(#fillRuns)"
            strokeWidth={1.5}
          />
        </AreaChart>
      </ChartContainer>
      <StatusStrip heartbeats={heartbeats} />
    </div>
  );
}
