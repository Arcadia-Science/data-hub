import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function PatternBadge(props: ComponentProps<typeof Badge>) {
  return (
    <Badge
      className="bg-slate-200 font-mono font-normal text-slate-800 text-xs dark:bg-slate-800 dark:text-slate-200"
      variant="outline"
      {...props}
    />
  );
}

/**
 * A watcher's `file_patterns` as badges, with a tooltip explaining what they
 * do. Past `maxVisible`, the rest collapse into a `+N` badge and are listed in
 * the tooltip instead, so the explanation never needs a second tooltip.
 */
export function FilePatterns({
  patterns,
  maxVisible,
}: {
  patterns: string[];
  maxVisible?: number;
}) {
  if (patterns.length === 0) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }

  const visible =
    maxVisible === undefined ? patterns : patterns.slice(0, maxVisible);
  const hidden = patterns.slice(visible.length);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-default flex-wrap gap-1" tabIndex={0}>
          <span className="sr-only">File patterns: </span>
          {visible.map((pattern) => (
            <PatternBadge key={pattern}>{pattern}</PatternBadge>
          ))}
          {hidden.length > 0 ? (
            <PatternBadge aria-label={`${hidden.length} more`}>
              +{hidden.length}
            </PatternBadge>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start" side="bottom">
        <p className="font-medium">File patterns</p>
        <p>
          The watcher only picks up files whose names match one of these
          patterns. Other files in the folder are ignored.
        </p>
        {hidden.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {hidden.map((pattern) => (
              <PatternBadge key={pattern}>{pattern}</PatternBadge>
            ))}
          </div>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
