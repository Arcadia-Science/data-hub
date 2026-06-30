"use client";

import { useState } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Separator } from "@/components/ui/separator";
import type { DateRange } from "./runs-date-filter";

function toDraft(value: DateRange): DayPickerRange {
  return {
    from: value.from ? new Date(value.from) : undefined,
    to: value.to ? new Date(value.to) : undefined,
  };
}

export function CalendarRangeView({
  initial,
  onCancel,
  onApply,
}: {
  initial: DateRange;
  onCancel: () => void;
  onApply: (range: { from: Date; to: Date }) => void;
}) {
  const [draft, setDraft] = useState<DayPickerRange>(() => toDraft(initial));

  const canApply = Boolean(draft.from && draft.to);

  function handleSelect(next: DayPickerRange | undefined) {
    setDraft(next ?? { from: undefined, to: undefined });
  }

  function handleApply() {
    if (!(draft.from && draft.to)) {
      return;
    }
    onApply({ from: draft.from, to: draft.to });
  }

  return (
    <div className="flex flex-col">
      <Calendar
        defaultMonth={draft.from ?? new Date()}
        mode="range"
        numberOfMonths={1}
        onSelect={handleSelect}
        selected={draft}
      />
      <Separator />
      <div className="flex items-center justify-between gap-2 p-2">
        <Button
          className="h-8 text-xs"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Back
        </Button>
        <Button
          className="h-8 text-xs"
          disabled={!canApply}
          onClick={handleApply}
          size="sm"
          type="button"
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
