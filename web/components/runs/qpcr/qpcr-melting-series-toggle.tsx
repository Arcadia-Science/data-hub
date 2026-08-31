"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  isQpcrMeltingSeriesId,
  QPCR_MELTING_SERIES_IDS,
  QPCR_MELTING_SERIES_META,
  type QpcrMeltingSeriesId,
} from "@/lib/runs/qpcr-melting";

export function QpcrMeltingSeriesToggle({
  onChange,
  value,
}: {
  onChange: (next: QpcrMeltingSeriesId) => void;
  value: QpcrMeltingSeriesId;
}) {
  return (
    <ToggleGroup
      aria-label="Series"
      onValueChange={(next) => {
        if (isQpcrMeltingSeriesId(next)) {
          onChange(next);
        }
      }}
      size="sm"
      type="single"
      value={value}
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
