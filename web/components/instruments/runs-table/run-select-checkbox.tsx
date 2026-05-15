"use client";

import { Checkbox } from "@/components/ui/checkbox";
import type { MouseEvent } from "react";

import { useRunSelection, type RunRef } from "./run-selection-provider";

// Stops row-click navigation when interacting with the checkbox.
function swallow(event: MouseEvent) {
  event.stopPropagation();
}

export function RunSelectCheckbox({ runRef }: { runRef: RunRef }) {
  const { actions, meta } = useRunSelection();
  return (
    <div onClick={swallow} className="flex items-center">
      <Checkbox
        aria-label={`Select run ${runRef.runId}`}
        checked={meta.isSelected(runRef.id)}
        onCheckedChange={() => actions.toggle(runRef)}
      />
    </div>
  );
}

export function RunSelectAllCheckbox({ refs }: { refs: RunRef[] }) {
  const { actions, meta } = useRunSelection();
  return (
    <div onClick={swallow} className="flex items-center">
      <Checkbox
        aria-label="Select all runs on this page"
        checked={refs.length > 0 && meta.allSelected(refs)}
        disabled={refs.length === 0}
        onCheckedChange={() => actions.selectMany(refs)}
      />
    </div>
  );
}
