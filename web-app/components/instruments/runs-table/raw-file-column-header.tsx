import { CircleHelp } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Column header for "Files" / "Size" on every runs table. The underlying
// aggregates in buildRunListQuery only count raw instrument files — derived
// artifacts from the processing pipeline are excluded — so we surface a
// tooltip explaining what's being counted.
export function RawFileColumnHeader({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={`About the ${label} column`}
        className="inline-flex h-8 cursor-help items-center gap-1.5 font-medium text-foreground"
      >
        {label}
        <CircleHelp
          className="size-3 text-muted-foreground"
          aria-hidden="true"
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        Counts raw instrument files only. Files derived by the processing
        pipeline are not included.
      </TooltipContent>
    </Tooltip>
  );
}
