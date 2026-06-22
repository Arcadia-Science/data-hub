"use client";

import { parse } from "csv-parse/browser/esm/sync";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

type SpectrumPoint = {
  wavenumber: number;
  intensity: number;
  intensityDarkSubtracted: number;
};

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
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full max-w-md justify-between font-normal"
          role="combobox"
          variant="outline"
        >
          <span className="truncate">
            {selected ? selected.filename : "Select a spectrum…"}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
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
                    onSelect={() => {
                      onSelect(s.fileId);
                      setOpen(false);
                    }}
                    value={s.filename}
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

export function RamanSpectrumViewer({
  spectra,
}: {
  spectra: RamanSpectrumFileRef[];
}) {
  const [selectedId, setSelectedId] = useState<number | null>(
    () => spectra[0]?.fileId ?? null
  );
  const [visible, setVisible] = useState<Series[]>(ALL_SERIES);
  // Bumped on retry to invalidate the cache entry and re-run the load effect
  // even when `selectedId` hasn't changed.
  const [retryNonce, setRetryNonce] = useState(0);
  // Only async resolutions (fetch success/failure) write to React state; all
  // synchronous transitions (idle / loading / cache-hit ready) are derived
  // during render. This avoids `react-hooks/set-state-in-effect` warnings.
  const [asyncResult, setAsyncResult] = useState<AsyncResult | null>(null);

  const currentIndex = useMemo(
    () =>
      selectedId == null
        ? -1
        : spectra.findIndex((s) => s.fileId === selectedId),
    [spectra, selectedId]
  );
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < spectra.length - 1;

  function goPrev() {
    if (!canGoPrev) {
      return;
    }
    setSelectedId(spectra[currentIndex - 1].fileId);
  }
  function goNext() {
    if (!canGoNext) {
      return;
    }
    setSelectedId(spectra[currentIndex + 1].fileId);
  }

  // Per-mount cache so toggling between already-loaded spectra is instant
  // and never re-hits S3.
  const cacheRef = useRef<Map<number, SpectrumPoint[]>>(new Map());

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
    // `retryNonce` participates so a retry that clears the cache entry forces
    // a fresh derivation back to "loading" before the next fetch resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, asyncResult, retryNonce]);

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
      <div className="flex items-center justify-between gap-2">
        <SpectrumPicker
          onSelect={setSelectedId}
          selectedId={selectedId}
          spectra={spectra}
        />
        <div className="flex items-center gap-1">
          <Button
            aria-label="Previous spectrum"
            disabled={!canGoPrev}
            onClick={goPrev}
            size="icon"
            variant="outline"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            aria-label="Next spectrum"
            disabled={!canGoNext}
            onClick={goNext}
            size="icon"
            variant="outline"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
      <div className="flex justify-end">
        <SeriesToggle onChange={setVisible} visible={visible} />
      </div>
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
