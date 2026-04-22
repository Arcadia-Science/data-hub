"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { formatDateRange } from "@/lib/date";
import { cn } from "@/lib/utils";
import { Calendar as CalendarIcon, Check, ChevronDown } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

export type DateRange = { from: string | null; to: string | null };

type PresetId = "24h" | "3d" | "1w" | "2w" | "1m";

type Preset = {
  id: PresetId;
  label: string;
  days: number;
};

// Module-scoped so we don't reallocate on every render.
const PRESETS: readonly Preset[] = [
  { id: "24h", label: "Last 24 hours", days: 1 },
  { id: "3d", label: "Last 3 days", days: 3 },
  { id: "1w", label: "Last week", days: 7 },
  { id: "2w", label: "Last 2 weeks", days: 14 },
  { id: "1m", label: "Last month", days: 30 },
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function resolveActivePreset(value: DateRange): PresetId | null {
  if (!value.from || value.to) return null;
  const fromMs = Date.parse(value.from);
  if (Number.isNaN(fromMs)) return null;
  const now = Date.now();
  // Pick the closest preset within a half-day tolerance so a value written a
  // few minutes ago still lights up its preset on subsequent renders.
  let best: PresetId | null = null;
  let bestDiff = Infinity;
  for (const preset of PRESETS) {
    const target = now - preset.days * MS_PER_DAY;
    const diff = Math.abs(target - fromMs);
    if (diff < MS_PER_DAY / 2 && diff < bestDiff) {
      bestDiff = diff;
      best = preset.id;
    }
  }
  return best;
}

function resolveLabel(value: DateRange): string {
  const preset = resolveActivePreset(value);
  if (preset) {
    return PRESETS.find((p) => p.id === preset)?.label ?? "Date range";
  }
  if (value.from && value.to) {
    return formatDateRange(new Date(value.from), new Date(value.to));
  }
  if (value.from) {
    return formatDateRange(new Date(value.from), new Date());
  }
  return "Last 24 hours";
}

// Calendar pulls in react-day-picker; load it only when the user opens the
// custom-range view so it stays out of the toolbar's initial bundle.
const CalendarRangeView = dynamic(
  () => import("./runs-date-filter-calendar").then((m) => m.CalendarRangeView),
  { ssr: false, loading: () => <CalendarRangeViewSkeleton /> }
);

function CalendarRangeViewSkeleton() {
  return (
    <div
      aria-hidden
      className="h-[360px] w-[280px] animate-pulse bg-muted/40"
    />
  );
}

export function RunsDateFilter({
  value,
  onChange,
  align = "end",
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  align?: "start" | "end" | "center";
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"presets" | "custom">("presets");

  const activePreset = useMemo(() => resolveActivePreset(value), [value]);
  const label = useMemo(() => resolveLabel(value), [value]);
  const isCustom =
    activePreset === null && (value.from !== null || value.to !== null);

  function openChange(next: boolean) {
    setOpen(next);
    // Always reset to the preset view when the popover reopens.
    if (!next) setView("presets");
  }

  function applyPreset(preset: Preset) {
    onChange({ from: isoDaysAgo(preset.days), to: null });
    setOpen(false);
  }

  function applyCustom(range: { from: Date; to: Date }) {
    // Snap start to 00:00 and end to 23:59:59.999 of the selected local day.
    const start = new Date(range.from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(range.to);
    end.setHours(23, 59, 59, 999);
    onChange({ from: start.toISOString(), to: end.toISOString() });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2 font-normal"
          aria-label="Date range"
        >
          <CalendarIcon className="size-3.5 text-muted-foreground" />
          <span className="text-xs">{label}</span>
          <ChevronDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-auto p-0"
        // Prevent the calendar's internal focus shifts from closing the popover.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {view === "presets" ? (
          <PresetList
            activePreset={activePreset}
            isCustom={isCustom}
            onSelectPreset={applyPreset}
            onOpenCustom={() => setView("custom")}
          />
        ) : (
          <CalendarRangeView
            initial={value}
            onCancel={() => setView("presets")}
            onApply={applyCustom}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PresetList({
  activePreset,
  isCustom,
  onSelectPreset,
  onOpenCustom,
}: {
  activePreset: PresetId | null;
  isCustom: boolean;
  onSelectPreset: (preset: Preset) => void;
  onOpenCustom: () => void;
}) {
  return (
    <div className="flex w-56 flex-col py-1">
      {PRESETS.map((preset) => {
        const active = preset.id === activePreset;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => onSelectPreset(preset)}
            className={cn(
              "flex items-center justify-between px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
              active && "font-medium"
            )}
          >
            <span>{preset.label}</span>
            {active ? (
              <Check className="size-3.5 text-muted-foreground" />
            ) : null}
          </button>
        );
      })}
      <Separator className="my-1" />
      <button
        type="button"
        onClick={onOpenCustom}
        className={cn(
          "flex items-center justify-between px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
          isCustom && "font-medium"
        )}
      >
        <span>Custom range…</span>
        {isCustom ? <Check className="size-3.5 text-muted-foreground" /> : null}
      </button>
    </div>
  );
}
