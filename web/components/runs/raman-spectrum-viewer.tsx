"use client";

import { parse } from "csv-parse/browser/esm/sync";
import { AlertTriangle } from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useReportItemsContext } from "@/components/runs/report-items-provider";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface SpectrumPoint {
  intensity: number;
  intensityDarkSubtracted: number;
  wavenumber: number;
}

type Series = "intensity" | "intensityDarkSubtracted";

// Two distinguishable shades of blue: lighter for the raw signal, deeper for
// the corrected signal so the dark-subtracted line reads as the primary
// series when both are visible.
const chartConfig = {
  intensity: {
    label: "Intensity",
    color: "#93c5fd", // tailwind blue-300
  },
  intensityDarkSubtracted: {
    label: "Intensity (dark-subtracted)",
    color: "#2563eb", // tailwind blue-600
  },
} satisfies ChartConfig;

const ALL_SERIES: Series[] = ["intensity", "intensityDarkSubtracted"];

const CSV_HEADER_INTENSITY = "Intensity";
const CSV_HEADER_DARK = "Intensity (dark-subtracted)";
const CSV_HEADER_WAVENUMBER = "Wavenumber";

async function fetchSpectrum(fileId: number): Promise<SpectrumPoint[]> {
  // The download endpoint 302-redirects to a short-lived presigned S3 URL.
  // The browser follows the redirect transparently, so the bytes flow
  // directly from S3 to the user with zero Vercel Fast Origin Transfer.
  const res = await fetch(`/api/v1/files/${fileId}/download`);
  if (!res.ok) {
    throw new Error(`Failed to load spectrum (HTTP ${res.status})`);
  }
  const text = await res.text();

  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rows.length === 0) {
    throw new Error("Spectrum CSV is empty");
  }
  const first = rows[0];
  if (
    !(
      CSV_HEADER_WAVENUMBER in first &&
      (CSV_HEADER_INTENSITY in first || CSV_HEADER_DARK in first)
    )
  ) {
    throw new Error(
      `CSV is missing expected columns (${CSV_HEADER_WAVENUMBER} + ${CSV_HEADER_INTENSITY}/${CSV_HEADER_DARK})`
    );
  }

  return rows
    .map<SpectrumPoint>((r) => ({
      wavenumber: Number(r[CSV_HEADER_WAVENUMBER]),
      intensity: Number(r[CSV_HEADER_INTENSITY]),
      intensityDarkSubtracted: Number(r[CSV_HEADER_DARK]),
    }))
    .filter((p) => Number.isFinite(p.wavenumber));
}

function SeriesToggle({
  visible,
  onChange,
}: {
  visible: Series[];
  onChange: (next: Series[]) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Series visibility"
      onValueChange={(next) => {
        // Don't let the user deselect every series — that would leave an
        // empty chart with no obvious way to recover.
        if (next.length === 0) {
          return;
        }
        onChange(next as Series[]);
      }}
      size="sm"
      type="multiple"
      value={visible}
    >
      {ALL_SERIES.map((key) => (
        <ToggleGroupItem className="gap-1.5 text-xs" key={key} value={key}>
          <span
            aria-hidden
            className="size-2.5 rounded-sm"
            style={{ backgroundColor: chartConfig[key].color }}
          />
          {chartConfig[key].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SpectrumChart({
  points,
  visible,
}: {
  points: SpectrumPoint[];
  visible: Series[];
}) {
  // Recharts performs best with stable, plain-array data; the upstream points
  // are already in render-ready shape, but memoize to keep referential
  // equality across unrelated parent renders (e.g. picker open/close).
  const data = useMemo(() => points, [points]);
  const showIntensity = visible.includes("intensity");
  const showDark = visible.includes("intensityDarkSubtracted");

  return (
    <ChartContainer className="aspect-auto h-80 w-full" config={chartConfig}>
      <LineChart
        data={data}
        // Bottom margin makes room for the X-axis title sitting below the
        // tick labels; the legend lives outside the chart now, so the chart
        // owns only the axes.
        margin={{ top: 8, right: 16, bottom: 28, left: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="wavenumber"
          domain={["dataMin", "dataMax"]}
          label={{
            value: "Wavenumber (cm\u207B\u00B9)",
            position: "insideBottom",
            offset: -16,
            style: {
              fontSize: 11,
              fill: "var(--color-muted-foreground)",
            },
          }}
          tickFormatter={(v: number) => v.toFixed(0)}
          tickLine={false}
          tickMargin={8}
          type="number"
        />
        <YAxis
          axisLine={false}
          tickFormatter={(v: number) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)
          }
          tickLine={false}
          tickMargin={8}
          width={64}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) =>
                typeof label === "number"
                  ? `${label.toFixed(2)} cm\u207B\u00B9`
                  : String(label)
              }
            />
          }
        />
        {showIntensity && (
          <Line
            dataKey="intensity"
            dot={false}
            isAnimationActive={false}
            name={chartConfig.intensity.label as string}
            stroke={chartConfig.intensity.color}
            strokeWidth={1.25}
          />
        )}
        {showDark && (
          <Line
            dataKey="intensityDarkSubtracted"
            dot={false}
            isAnimationActive={false}
            name={chartConfig.intensityDarkSubtracted.label as string}
            stroke={chartConfig.intensityDarkSubtracted.color}
            strokeWidth={1.25}
          />
        )}
      </LineChart>
    </ChartContainer>
  );
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; points: SpectrumPoint[] }
  | { status: "error"; message: string };

// Async-resolution result, tagged with the fileId it belongs to so we can
// ignore it during render when the user has already moved on to a different
// spectrum.
type AsyncResult =
  | { fileId: number; status: "ready"; points: SpectrumPoint[] }
  | { fileId: number; status: "error"; message: string };

export function RamanSpectrumViewer() {
  const { state: items } = useReportItemsContext();
  const selectedId = items.selectedItem?.id ?? null;
  const [visible, setVisible] = useState<Series[]>(ALL_SERIES);
  // Bumped on retry to invalidate the cache entry and re-run the load effect
  // even when `selectedId` hasn't changed.
  const [retryNonce, setRetryNonce] = useState(0);
  // Only async resolutions (fetch success/failure) write to React state; all
  // synchronous transitions (idle / loading / cache-hit ready) are derived
  // during render. This avoids `react-hooks/set-state-in-effect` warnings.
  const [asyncResult, setAsyncResult] = useState<AsyncResult | null>(null);

  // Per-mount cache so toggling between already-loaded spectra is instant
  // and never re-hits S3.
  const cacheRef = useRef<Map<number, SpectrumPoint[]>>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce retriggers loading state after cache clear on retry
  const state: LoadState = useMemo(() => {
    if (selectedId == null) {
      return { status: "idle" };
    }
    const cached = cacheRef.current.get(selectedId);
    if (cached) {
      return { status: "ready", points: cached };
    }
    if (asyncResult && asyncResult.fileId === selectedId) {
      return asyncResult.status === "ready"
        ? { status: "ready", points: asyncResult.points }
        : { status: "error", message: asyncResult.message };
    }
    return { status: "loading" };
  }, [selectedId, asyncResult, retryNonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce retriggers fetch when the user retries after an error
  useEffect(() => {
    if (selectedId == null) {
      return;
    }
    if (cacheRef.current.has(selectedId)) {
      return;
    }

    let cancelled = false;
    fetchSpectrum(selectedId)
      .then((points) => {
        cacheRef.current.set(selectedId, points);
        if (cancelled) {
          return;
        }
        // Rendering ~2k points to recharts is the heavy part of this update;
        // a transition lets the picker close stay snappy.
        startTransition(() => {
          setAsyncResult({ fileId: selectedId, status: "ready", points });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          err instanceof Error ? err.message : "Failed to load spectrum";
        setAsyncResult({ fileId: selectedId, status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, retryNonce]);

  function handleRetry() {
    if (selectedId == null) {
      return;
    }
    cacheRef.current.delete(selectedId);
    setAsyncResult(null);
    setRetryNonce((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <SeriesToggle onChange={setVisible} visible={visible} />
      </div>
      {state.status === "idle" && (
        <div className="flex h-80 items-center justify-center rounded-md border border-dashed bg-muted/20 text-center text-muted-foreground text-sm">
          {items.error ??
            (items.isLoading ? "Loading\u2026" : "No spectra found.")}
        </div>
      )}
      {state.status === "loading" && (
        <Skeleton aria-label="Loading spectrum" className="h-80 w-full" />
      )}
      {state.status === "error" && (
        <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
          <AlertTriangle aria-hidden className="size-6 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">{state.message}</p>
          <Button onClick={handleRetry} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {state.status === "ready" && (
        <SpectrumChart points={state.points} visible={visible} />
      )}
    </div>
  );
}
