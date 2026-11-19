"use client";

import { ExternalLink, NotebookText } from "lucide-react";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { NotebookExternalLink } from "@/components/notebooks/notebook-external-link";
import { TruncatedTooltip } from "@/components/truncated-tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { RunNotebookWire } from "@/lib/api/notebook-wire";
import { notebookPageHref } from "@/lib/notebooks/details";
import {
  matchingNotebookFirst,
  readNotebookFilter,
} from "@/lib/runs/notebook-filter";
import { notebookFilterSearchParams } from "@/lib/search-params";

/**
 * The lab notebooks a run is in, in a runs table: the first one by name, and
 * a "+N" button that lists them all when the run is in more than one. While
 * the column is filtered to one notebook, or the table is on a notebook's
 * page (`pageNotebookId`), that notebook comes first. A name opens the
 * notebook's page in Data Hub, and the icon beside it opens the notebook
 * itself in a new tab. On a notebook's own page, linking to that page would
 * go nowhere, so its name and icon are one link that opens the notebook.
 *
 * Links skip prefetching: a table can show dozens of them.
 */
export function NotebookLinksCell({
  notebooks,
  pageNotebookId,
}: {
  notebooks: RunNotebookWire[];
  // The notebook whose page the table is on, if any.
  pageNotebookId?: string;
}) {
  const [params] = useQueryStates(notebookFilterSearchParams);
  const filter = readNotebookFilter(params);
  const ordered = matchingNotebookFirst(
    notebooks,
    pageNotebookId ?? (filter.kind === "notebook" ? filter.id : null)
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
    <div className="flex max-w-64 items-center gap-0.5">
      {first.id === pageNotebookId ? (
        <TruncatedTooltip text={first.name}>
          <a
            className="group/notebook relative z-10 flex min-w-0 items-center gap-1.5 rounded-sm text-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            href={first.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="min-w-0 truncate">{first.name}</span>
            <ExternalLink
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground group-hover/notebook:text-foreground"
            />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </TruncatedTooltip>
      ) : (
        <>
          <TruncatedTooltip text={first.name}>
            <Link
              className="relative z-10 min-w-0 truncate rounded-sm text-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              href={notebookPageHref(first.id)}
              prefetch={false}
            >
              {first.name}
            </Link>
          </TruncatedTooltip>
          <NotebookExternalLink
            className="relative z-10"
            name={first.name}
            url={first.url}
          />
        </>
      )}
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
                <li className="flex items-center gap-1" key={notebook.id}>
                  {notebook.id === pageNotebookId ? (
                    <a
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      href={notebook.url}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <NotebookText
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">{notebook.name}</span>
                      <ExternalLink
                        aria-hidden="true"
                        className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    <>
                      <Link
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                        href={notebookPageHref(notebook.id)}
                        prefetch={false}
                      >
                        <NotebookText
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{notebook.name}</span>
                      </Link>
                      <NotebookExternalLink
                        name={notebook.name}
                        url={notebook.url}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
