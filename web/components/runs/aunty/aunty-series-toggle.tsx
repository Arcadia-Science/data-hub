"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AUNTY_SERIES_META,
  type AuntySeriesId,
  isAuntySeriesId,
} from "@/lib/runs/aunty";

export function AuntySeriesToggle({
  onChange,
  options,
  value,
}: {
  onChange: (next: AuntySeriesId) => void;
  options: AuntySeriesId[];
  value: AuntySeriesId;
}) {
  if (options.length <= 1) {
    return null;
  }

  return (
    <ToggleGroup
      aria-label="Series"
      onValueChange={(next) => {
        if (isAuntySeriesId(next)) {
          onChange(next);
        }
      }}
      size="sm"
      type="single"
      value={value}
    >
      {options.map((id) => (
        <ToggleGroupItem className="gap-1.5 text-xs" key={id} value={id}>
          <span
            aria-hidden
            className="size-2.5 rounded-sm"
            style={{ backgroundColor: AUNTY_SERIES_META[id].color }}
          />
          {AUNTY_SERIES_META[id].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
