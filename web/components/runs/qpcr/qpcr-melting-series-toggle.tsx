"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  QPCR_MELTING_SERIES_IDS,
  QPCR_MELTING_SERIES_META,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

// Multi-select: either series can be hidden, including both, which leaves an
// empty plate rather than forcing a choice the reader did not ask for.
export function QpcrMeltingSeriesToggle({
  onChange,
  value,
}: {
  onChange: (next: QpcrMeltingSeriesId[]) => void;
  value: readonly QpcrMeltingSeriesId[];
}) {
  return (
    <ToggleGroup
      aria-label="Series"
      onValueChange={(next: string[]) =>
        // Re-derive from the canonical order so the chart's axis sides and
        // line order do not depend on which chip the reader clicked first.
        onChange(QPCR_MELTING_SERIES_IDS.filter((id) => next.includes(id)))
      }
      size="sm"
      type="multiple"
      value={[...value]}
    >
      {QPCR_MELTING_SERIES_IDS.map((id) => (
        <ToggleGroupItem className="gap-1.5 text-xs" key={id} value={id}>
          <span
            aria-hidden
            className="size-2.5 rounded-sm"
            style={{ backgroundColor: QPCR_MELTING_SERIES_META[id].color }}
          />
          {QPCR_MELTING_SERIES_META[id].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
