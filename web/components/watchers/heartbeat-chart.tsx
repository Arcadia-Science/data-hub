"use client";

import { HeartPulse } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useTablePending } from "@/components/table-pending";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WatcherHeartbeatRow } from "@/lib/api/watchers";
import { formatDateTime, formatTime } from "@/lib/date";
import { cn } from "@/lib/utils";

const chartConfig = {
  files: { label: "Files", color: "var(--color-primary)" },
  runs: { label: "Runs", color: "var(--color-chart-2)" },
  errors: { label: "Errors", color: "var(--color-destructive)" },
} satisfies ChartConfig;

const STATUS_COLORS: Record<string, string> = {
  watching: "bg-emerald-500",
  stopped: "bg-muted-foreground/40",
};

const BUCKET_COUNT = 48;

const FIVE_MIN = 5 * 60 * 1000;

function computeWindow(since: string): {
  windowStart: Date;
  windowEnd: Date;
} {
  const now = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN;
  const windowStart = new Date(`${since}T00:00:00`);
  const endOfDay = new Date(`${since}T00:00:00`);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const windowEnd = endOfDay.getTime() > now ? new Date(now) : endOfDay;
  return { windowStart, windowEnd };
}

interface Bucket {
  className: string;
  endTime: Date;
  heartbeatCount: number;
  key: number;
  label: string;
  startTime: Date;
}

function buildBuckets(
  heartbeats: WatcherHeartbeatRow[],
  windowStart: Date,
  windowEnd: Date
): Bucket[] {
  const windowMs = windowEnd.getTime() - windowStart.getTime();
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const bucketMs = windowMs / BUCKET_COUNT;

  const statuses: (string | null)[] = new Array(BUCKET_COUNT).fill(null);
  const counts: number[] = new Array(BUCKET_COUNT).fill(0);

  for (const hb of heartbeats) {
    const ts = hb.timestamp.getTime();
    if (ts < startMs || ts >= endMs) {
      continue;
    }

    const idx = Math.min(
      Math.floor((ts - startMs) / bucketMs),
      BUCKET_COUNT - 1
    );

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

  return statuses.map((status, i) => ({
    key: i,
    className:
      status === null ? "bg-muted" : (STATUS_COLORS[status] ?? "bg-amber-500"),
    label: status === null ? "No data" : (STATUS_LABELS[status] ?? status),
    startTime: new Date(startMs + i * bucketMs),
    endTime: new Date(startMs + (i + 1) * bucketMs),
    heartbeatCount: counts[i],
  }));
}

function StatusStrip({
  heartbeats,
  windowStart,
  windowEnd,
}: {
  heartbeats: WatcherHeartbeatRow[];
  windowStart: Date;
  windowEnd: Date;
}) {
  const buckets = useMemo(
    () => buildBuckets(heartbeats, windowStart, windowEnd),
    [heartbeats, windowStart, windowEnd]
  );

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs">Connectivity</span>
      <div className="flex h-6 w-full items-stretch gap-0.5">
        {buckets.map((bucket) => (
          <Tooltip delayDuration={0} key={bucket.key}>
            <TooltipTrigger asChild>
              <div className={cn("flex-1 rounded-sm", bucket.className)} />
            </TooltipTrigger>
            <TooltipContent className="text-xs" side="top">
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

function HeartbeatChartSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-4 dark:bg-muted">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="mx-auto h-3 w-48" />
      <Skeleton className="mt-2 h-6 w-full" />
    </div>
  );
}

export function HeartbeatChart({
  heartbeats,
  since,
}: {
  heartbeats: WatcherHeartbeatRow[];
  since: string;
}) {
  // Reflect the surrounding TablePendingProvider's transition state so that we
  // can swap to a loading skeleton when the date filter changes — the
  // server-side fetch hasn't returned yet, but the new `since` window has
  // already been applied client-side, so the previously loaded heartbeats fall
  // outside the window and `data` would otherwise be empty.
  const { isPending } = useTablePending();

  const { windowStart, windowEnd } = useMemo(
    () => computeWindow(since),
    [since]
  );

  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();

  const data = useMemo(
    () =>
      heartbeats
        .filter((hb) => {
          const ts = hb.timestamp.getTime();
          return ts >= startMs && ts < endMs;
        })
        .map((hb) => ({
          timestamp: hb.timestamp.getTime(),
          files: hb.filesUploadedSinceLast ?? 0,
          runs: hb.runsReportedSinceLast ?? 0,
          errors: hb.errorsSinceLast ?? 0,
        })),
    [heartbeats, startMs, endMs]
  );

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const windowMs = endMs - startMs;
  const widthMultiplier = Math.max(1, windowMs / SIX_HOURS_MS);
  const needsScroll = widthMultiplier > 1;

  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll to the latest buckets when heartbeat data changes
  useEffect(() => {
    const el = scrollRef.current;
    if (el && needsScroll) {
      el.scrollLeft = el.scrollWidth;
    }
  }, [data, needsScroll]);

  if (isPending) {
    return <HeartbeatChartSkeleton />;
  }

  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background py-8 dark:bg-muted">
        <HeartPulse className="size-6 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">
          No heartbeats in this time range.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background p-4 dark:bg-muted">
      <div className={cn(needsScroll && "overflow-x-auto")} ref={scrollRef}>
        <div
          style={
            needsScroll ? { minWidth: `${widthMultiplier * 100}%` } : undefined
          }
        >
          <ChartContainer
            className="aspect-auto h-64 w-full"
            config={chartConfig}
          >
            <AreaChart
              data={data}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="fillFiles" x1="0" x2="0" y1="0" y2="1">
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
                <linearGradient id="fillRuns" x1="0" x2="0" y1="0" y2="1">
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
                <linearGradient id="fillErrors" x1="0" x2="0" y1="0" y2="1">
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
                axisLine={false}
                dataKey="timestamp"
                domain={[startMs, endMs]}
                minTickGap={40}
                scale="time"
                tickFormatter={(v: number) => formatTime(new Date(v))}
                tickLine={false}
                tickMargin={8}
                type="number"
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                width={32}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const ts = payload?.[0]?.payload?.timestamp;
                      return ts ? formatDateTime(new Date(ts)) : "";
                    }}
                  />
                }
              />
              <Area
                dataKey="errors"
                fill="url(#fillErrors)"
                stroke="var(--color-errors)"
                strokeWidth={1.5}
                type="monotone"
              />
              <Area
                dataKey="files"
                fill="url(#fillFiles)"
                stroke="var(--color-files)"
                strokeWidth={1.5}
                type="monotone"
              />
              <Area
                dataKey="runs"
                fill="url(#fillRuns)"
                stroke="var(--color-runs)"
                strokeWidth={1.5}
                type="monotone"
              />
            </AreaChart>
          </ChartContainer>
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 py-2 text-xs">
        {Object.entries(chartConfig).map(([key, { label, color }]) => (
          <div className="flex items-center gap-1.5" key={key}>
            <div
              className="size-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      <StatusStrip
        heartbeats={heartbeats}
        windowEnd={windowEnd}
        windowStart={windowStart}
      />
    </div>
  );
}
