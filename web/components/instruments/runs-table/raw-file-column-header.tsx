import { CircleHelp } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Label + help tooltip for "Files" / "Size". The underlying aggregates only
// count raw instrument files — derived artifacts from the processing pipeline
// are excluded — so we surface a tooltip explaining what's being counted.
// Used as a table column header and as a run-metadata field label.
export function RawFileColumnHeader({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`About ${label}`}
        className={cn(
          "inline-flex h-8 cursor-help items-center gap-1.5 font-medium text-foreground",
          className
        )}
        type="button"
      >
        {label}
        <CircleHelp
          aria-hidden="true"
          className="size-3 text-muted-foreground"
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        Counts raw instrument files only. Files derived by the processing
        pipeline are not included.
      </TooltipContent>
    </Tooltip>
  );
}
