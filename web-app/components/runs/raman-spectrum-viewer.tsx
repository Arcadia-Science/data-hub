"use client";

import type { RamanSpectrumFileRef } from "@/components/runs/raman-report-section";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { parse } from "csv-parse/browser/esm/sync";
import { AlertTriangle, Check, ChevronsUpDown } from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, XAxis, YAxis } from "recharts";

type SpectrumPoint = {
  wavenumber: number;
  intensity: number;
  intensityDarkSubtracted: number;
};

const chartConfig = {
  intensity: {
    label: "Intensity",
    color: "var(--color-chart-1)",
  },
  intensityDarkSubtracted: {
    label: "Intensity (dark-subtracted)",
    color: "var(--color-chart-2)",
  },
} satisfies ChartConfig;

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
    !(CSV_HEADER_WAVENUMBER in first) ||
    !(CSV_HEADER_INTENSITY in first || CSV_HEADER_DARK in first)
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

function SpectrumPicker({
  spectra,
  selectedId,
  onSelect,
}: {
  spectra: RamanSpectrumFileRef[];
  selectedId: number | null;
  onSelect: (fileId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = spectra.find((s) => s.fileId === selectedId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full max-w-md justify-between font-normal"
        >
          <span className="truncate">
            {selected ? selected.filename : "Select a spectrum…"}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search spectra..." />
          <CommandList>
            <CommandEmpty>No spectra found.</CommandEmpty>
            <CommandGroup>
              {spectra.map((s) => {
                const isSelected = s.fileId === selectedId;
                return (
                  <CommandItem
                    key={s.fileId}
                    value={s.filename}
                    onSelect={() => {
                      onSelect(s.fileId);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{s.filename}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SpectrumChart({ points }: { points: SpectrumPoint[] }) {
  // Recharts performs best with stable, plain-array data; the upstream points
  // are already in render-ready shape, but memoize to keep referential
  // equality across unrelated parent renders (e.g. picker open/close).
  const data = useMemo(() => points, [points]);

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-80 w-full">
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="wavenumber"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v: number) => v.toFixed(0)}
          label={{
            value: "Wavenumber (cm\u207B\u00B9)",
            position: "insideBottom",
            offset: -2,
            style: {
              fontSize: 11,
              fill: "var(--color-muted-foreground)",
            },
          }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={64}
          tickFormatter={(v: number) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)
          }
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
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
          iconType="line"
        />
        <Line
          name={chartConfig.intensity.label as string}
          dataKey="intensity"
          stroke="var(--color-intensity)"
          strokeWidth={1.25}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          name={chartConfig.intensityDarkSubtracted.label as string}
          dataKey="intensityDarkSubtracted"
          stroke="var(--color-intensityDarkSubtracted)"
          strokeWidth={1.25}
          dot={false}
          isAnimationActive={false}
        />
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

export function RamanSpectrumViewer({
  spectra,
}: {
  spectra: RamanSpectrumFileRef[];
}) {
  const [selectedId, setSelectedId] = useState<number | null>(
    () => spectra[0]?.fileId ?? null
  );
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

  const state: LoadState = useMemo(() => {
    if (selectedId == null) return { status: "idle" };
    const cached = cacheRef.current.get(selectedId);
    if (cached) return { status: "ready", points: cached };
    if (asyncResult && asyncResult.fileId === selectedId) {
      return asyncResult.status === "ready"
        ? { status: "ready", points: asyncResult.points }
        : { status: "error", message: asyncResult.message };
    }
    return { status: "loading" };
    // `retryNonce` participates so a retry that clears the cache entry forces
    // a fresh derivation back to "loading" before the next fetch resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, asyncResult, retryNonce]);

  useEffect(() => {
    if (selectedId == null) return;
    if (cacheRef.current.has(selectedId)) return;

    let cancelled = false;
    fetchSpectrum(selectedId)
      .then((points) => {
        cacheRef.current.set(selectedId, points);
        if (cancelled) return;
        // Rendering ~2k points to recharts is the heavy part of this update;
        // a transition lets the picker close stay snappy.
        startTransition(() => {
          setAsyncResult({ fileId: selectedId, status: "ready", points });
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to load spectrum";
        setAsyncResult({ fileId: selectedId, status: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedId, retryNonce]);

  function handleRetry() {
    if (selectedId == null) return;
    cacheRef.current.delete(selectedId);
    setAsyncResult(null);
    setRetryNonce((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <SpectrumPicker
        spectra={spectra}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {state.status === "loading" && (
        <Skeleton className="h-80 w-full" aria-label="Loading spectrum" />
      )}
      {state.status === "error" && (
        <div className="flex h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/20 p-6 text-center">
          <AlertTriangle className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}
      {state.status === "ready" && <SpectrumChart points={state.points} />}
    </div>
  );
}
