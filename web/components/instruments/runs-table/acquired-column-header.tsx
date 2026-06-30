import { CircleHelp } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Column header for the acquisition-time column on every runs table. The
// cell renders coalesce(acquired_at, created_at): when the watcher knows
// the run's actual on-instrument acquisition time we surface that,
// otherwise we fall back to when Data Hub learned about the run. The
// tooltip makes the fallback explicit so a "runs from yesterday" filter
// result isn't surprising.
export function AcquiredColumnHeader() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="About the Acquired column"
        className="inline-flex h-8 cursor-help items-center gap-1.5 font-medium text-foreground"
        type="button"
      >
        Acquired
        <CircleHelp
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        When the run was acquired on the instrument. Falls back to when Data Hub
        first heard about it for older or Lambda-created runs.
      </TooltipContent>
    </Tooltip>
  );
}
