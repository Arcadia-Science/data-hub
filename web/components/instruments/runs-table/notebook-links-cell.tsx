"use client";

import { ExternalLink } from "lucide-react";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { NotebookLinkWire } from "@/lib/api/run-notebook-link-wire";

/** Options for the "Lab Notebook" column's filter menu. */
export const NOTEBOOK_LINK_FILTER_OPTIONS = [
  { value: "true", label: "Has a link" },
  { value: "false", label: "No link" },
];

/**
 * A run's lab notebook links in a runs table: the first link by name, and a
 * "+N" button that lists them all when the run has more than one.
 */
export function NotebookLinksCell({ links }: { links: NotebookLinkWire[] }) {
  const [first, ...rest] = links;
  if (!first) {
    return (
      <span className="text-muted-foreground text-sm">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No lab notebook links</span>
      </span>
    );
  }

  return (
    <div className="flex max-w-56 items-center gap-1">
      <TruncatedTooltip text={first.display_name}>
        <a
          className="relative z-10 truncate rounded-sm text-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          href={first.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {first.display_name}
        </a>
      </TruncatedTooltip>
      {rest.length > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Show all ${links.length} lab notebook links`}
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
              {links.map((link) => (
                <li key={link.id}>
                  <a
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    href={link.url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={link.url}
                  >
                    <ExternalLink
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{link.display_name}</span>
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
