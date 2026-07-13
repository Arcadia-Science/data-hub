"use client";

import { Calendar as CalendarIcon, Check, ChevronDown } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  formatDateRange,
  getBrowserTimeZone,
  startOfMonthISO,
  startOfTodayISO,
  startOfWeekISO,
  startOfYesterdayISO,
} from "@/lib/date";
import { cn } from "@/lib/utils";

export interface DateRange {
  from: string | null;
  to: string | null;
}

export type PresetId =
  | "today"
  | "yesterday"
  | "week"
  | "7d"
  | "2w"
  | "month"
  | "4w";

interface Preset {
  id: PresetId;
  label: string;
}

// Module-scoped so we don't reallocate on every render.
const PRESETS: readonly Preset[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "7d", label: "Last 7 days" },
  { id: "2w", label: "Last 2 weeks" },
  { id: "month", label: "This month" },
  { id: "4w", label: "Last 4 weeks" },
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Calendar presets are exact midnight cutoffs; allow a small clock skew. */
const CALENDAR_TOLERANCE_MS = 60_000;

const ROLLING_PRESETS: readonly { days: number; id: PresetId }[] = [
  { id: "7d", days: 7 },
  { id: "2w", days: 14 },
  { id: "4w", days: 28 },
] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function withinTolerance(aMs: number, bMs: number): boolean {
  return Math.abs(aMs - bMs) < CALENDAR_TOLERANCE_MS;
}

function rangesEqual(a: DateRange, b: DateRange): boolean {
  return a.from === b.from && a.to === b.to;
}

/**
 * Resolves a preset to URL `date_from` / `date_to` values.
 *
 * Open-ended presets (today / this week / this month / rolling) leave `to`
 * null. Bounded presets (yesterday) set `to` to the start of the inclusive
 * end day so the list API's "advance date_to by one day" rule yields the
 * correct exclusive upper bound (start of today).
 */
function rangeForPreset(id: PresetId): DateRange {
  const tz = getBrowserTimeZone();
  switch (id) {
    case "today":
      return { from: startOfTodayISO(tz), to: null };
    case "yesterday": {
      const start = startOfYesterdayISO(tz);
      return { from: start, to: start };
    }
    case "week":
      return { from: startOfWeekISO(tz), to: null };
    case "7d":
      return { from: isoDaysAgo(7), to: null };
    case "2w":
      return { from: isoDaysAgo(14), to: null };
    case "month":
      return { from: startOfMonthISO(tz), to: null };
    case "4w":
      return { from: isoDaysAgo(28), to: null };
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unhandled preset: ${_exhaustive}`);
    }
  }
}

/**
 * Infer which preset matches URL bounds. On Mondays (and the 1st), today /
 * this-week / this-month share a midnight `from`, so we prefer the shortest
 * window (today → week → month). Interactive picks that collide are kept via
 * `pinnedPreset` in `RunsDateFilter`.
 */
function resolveActivePreset(value: DateRange): PresetId | null {
  if (!value.from) {
    return null;
  }
  const fromMs = Date.parse(value.from);
  if (Number.isNaN(fromMs)) {
    return null;
  }
  const toMs = value.to ? Date.parse(value.to) : null;
  if (value.to && (toMs === null || Number.isNaN(toMs))) {
    return null;
  }

  const tz = getBrowserTimeZone();

  // Bounded calendar presets (require both ends).
  if (toMs !== null) {
    const yesterdayStart = Date.parse(startOfYesterdayISO(tz));
    if (
      withinTolerance(fromMs, yesterdayStart) &&
      withinTolerance(toMs, yesterdayStart)
    ) {
      return "yesterday";
    }
    return null;
  }

  // Open-ended calendar presets (shortest match first — see docstring).
  if (withinTolerance(fromMs, Date.parse(startOfTodayISO(tz)))) {
    return "today";
  }
  if (withinTolerance(fromMs, Date.parse(startOfWeekISO(tz)))) {
    return "week";
  }
  if (withinTolerance(fromMs, Date.parse(startOfMonthISO(tz)))) {
    return "month";
  }

  // Rolling presets: closest within a half-day tolerance so a value written a
  // few minutes ago still lights up its preset on subsequent renders.
  const now = Date.now();
  let best: PresetId | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const { id, days } of ROLLING_PRESETS) {
    const target = now - days * MS_PER_DAY;
    const diff = Math.abs(target - fromMs);
    if (diff < MS_PER_DAY / 2 && diff < bestDiff) {
      bestDiff = diff;
      best = id;
    }
  }
  return best;
}

function presetLabel(id: PresetId): string {
  return PRESETS.find((p) => p.id === id)?.label ?? "Date range";
}

function resolveLabel(
  value: DateRange,
  activePreset: PresetId | null,
  defaultPreset?: PresetId
): string {
  if (activePreset) {
    return presetLabel(activePreset);
  }
  if (value.from && value.to) {
    return formatDateRange(new Date(value.from), new Date(value.to));
  }
  if (value.from) {
    return formatDateRange(new Date(value.from), new Date());
  }
  return defaultPreset ? presetLabel(defaultPreset) : "All time";
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
  defaultPreset,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  align?: "start" | "end" | "center";
  /**
   * The preset that represents the page's server-side default when no filter
   * is in the URL. When set, the trigger label reflects it and the preset is
   * highlighted in the popover; the "All time" item is hidden since clearing
   * the filter would not actually show all runs.
   */
  defaultPreset?: PresetId;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"presets" | "custom">("presets");
  // When today / this-week / this-month share a midnight cutoff, keep the
  // preset the user last clicked so the popover highlight matches intent.
  const [pinnedPreset, setPinnedPreset] = useState<PresetId | null>(null);

  const isEmpty = value.from === null && value.to === null;
  const pinMatches =
    pinnedPreset !== null && rangesEqual(value, rangeForPreset(pinnedPreset));
  const resolved = resolveActivePreset(value);
  const activePreset = pinMatches
    ? pinnedPreset
    : (resolved ?? (isEmpty && defaultPreset ? defaultPreset : null));
  const label = resolveLabel(value, activePreset, defaultPreset);
  const isCustom =
    activePreset === null && (value.from !== null || value.to !== null);

  function openChange(next: boolean) {
    setOpen(next);
    // Always reset to the preset view when the popover reopens.
    if (!next) {
      setView("presets");
    }
  }

  function applyPreset(preset: Preset) {
    setPinnedPreset(preset.id);
    onChange(rangeForPreset(preset.id));
    setOpen(false);
  }

  function clearRange() {
    setPinnedPreset(null);
    onChange({ from: null, to: null });
    setOpen(false);
  }

  function applyCustom(range: { from: Date; to: Date }) {
    setPinnedPreset(null);
    // Snap start to 00:00 and end to 23:59:59.999 of the selected local day.
    const start = new Date(range.from);
    start.setHours(0, 0, 0, 0);
    const end = new Date(range.to);
    end.setHours(23, 59, 59, 999);
    onChange({ from: start.toISOString(), to: end.toISOString() });
    setOpen(false);
  }

  return (
    <Popover onOpenChange={openChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Date range"
          className="h-9 gap-2 font-normal"
          size="sm"
          variant="outline"
        >
          <CalendarIcon className="size-3.5 text-muted-foreground" />
          <span className="text-sm">{label}</span>
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
            onClear={clearRange}
            onOpenCustom={() => setView("custom")}
            onSelectPreset={applyPreset}
            showAllTime={!defaultPreset}
          />
        ) : (
          <CalendarRangeView
            initial={value}
            onApply={applyCustom}
            onCancel={() => setView("presets")}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function PresetList({
  activePreset,
  isCustom,
  showAllTime,
  onSelectPreset,
  onClear,
  onOpenCustom,
}: {
  activePreset: PresetId | null;
  isCustom: boolean;
  showAllTime: boolean;
  onSelectPreset: (preset: Preset) => void;
  onClear: () => void;
  onOpenCustom: () => void;
}) {
  const isAllTime = activePreset === null && !isCustom;
  return (
    <div className="flex w-56 flex-col py-1">
      {showAllTime ? (
        <>
          <PresetItem active={isAllTime} label="All time" onSelect={onClear} />
          <Separator className="my-1" />
        </>
      ) : null}
      {PRESETS.map((preset) => (
        <PresetItem
          active={preset.id === activePreset}
          key={preset.id}
          label={preset.label}
          onSelect={() => onSelectPreset(preset)}
        />
      ))}
      <Separator className="my-1" />
      <PresetItem
        active={isCustom}
        label="Custom range…"
        onSelect={onOpenCustom}
      />
    </div>
  );
}

function PresetItem({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={cn(
        "flex items-center justify-between px-3 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent",
        active && "font-medium"
      )}
      onClick={onSelect}
      type="button"
    >
      <span>{label}</span>
      {active ? <Check className="size-3.5 text-muted-foreground" /> : null}
    </button>
  );
}
