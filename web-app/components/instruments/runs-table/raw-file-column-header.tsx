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
      <TooltipTrigger asChild>
        <span className="cursor-help border-b border-dashed border-muted-foreground/40">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        Counts raw instrument files only. Files derived by the processing
        pipeline are not included.
      </TooltipContent>
    </Tooltip>
  );
}
