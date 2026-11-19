"use client";

import { ExternalLink } from "lucide-react";
import { useQueryStates } from "nuqs";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RunNotebookWire } from "@/lib/api/notebook-wire";
import {
  matchingNotebookFirst,
  readNotebookFilter,
} from "@/lib/runs/notebook-filter";
import { notebookFilterSearchParams } from "@/lib/search-params";

/**
 * The lab notebooks a run is in, in a runs table: the first one by name, and
 * a "+N" button that lists them all when the run is in more than one. While
 * the column is filtered to one notebook, that notebook comes first. A name
 * opens the notebook's page.
 */
export function NotebookLinksCell({
  notebooks,
}: {
  notebooks: RunNotebookWire[];
}) {
  const [params] = useQueryStates(notebookFilterSearchParams);
  const filter = readNotebookFilter(params);
  const ordered = matchingNotebookFirst(
    notebooks,
    filter.kind === "notebook" ? filter.id : null
  );
  const [first, ...rest] = ordered;
  if (!first) {
    return (
      <span className="text-muted-foreground text-sm">
        <span aria-hidden="true">—</span>
        <span className="sr-only">In no lab notebook</span>
      </span>
    );
  }

  return (
    <div className="flex max-w-56 items-center gap-1">
      <TruncatedTooltip text={first.name}>
        <a
          className="relative z-10 truncate rounded-sm text-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          href={first.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {first.name}
        </a>
      </TruncatedTooltip>
      {rest.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Show all ${notebooks.length} lab notebooks`}
              className="relative z-10 h-6 shrink-0 px-1.5 text-muted-foreground text-xs tabular-nums"
              size="sm"
              type="button"
              variant="ghost"
            >
              +{rest.length}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1">
            <ul className="flex flex-col">
              {ordered.map((notebook) => (
                <li key={notebook.id}>
                  <a
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    href={notebook.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={notebook.url}
                  >
                    <ExternalLink
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{notebook.name}</span>
                  </a>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
