"use client";

import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Highlight } from "@/components/search/highlight";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  countRunsWithNameContaining,
  type NotebookLinkFilter,
  type NotebookLinkNameOptions,
  notebookLinkNameContains,
} from "@/lib/notebook-links/name-filter";
import { cn } from "@/lib/utils";

// Lives in its own module so a runs table loads the command menu library only
// when the "Lab Notebook" menu opens.
export function NotebookLinkFilterList({
  filter,
  onSelect,
  options,
}: {
  filter: NotebookLinkFilter;
  onSelect: (filter: NotebookLinkFilter) => void;
  options: NotebookLinkNameOptions;
}) {
  // Reopening the menu on a "containing" filter shows the text it matched.
  const [query, setQuery] = useState(
    filter.kind === "search" ? filter.text : ""
  );
  const text = query.trim();
  const names = text
    ? options.names.filter((entry) =>
        notebookLinkNameContains(entry.name, text)
      )
    : options.names;

  return (
    // Matching is by substring, like the run list query, so cmdk's fuzzy
    // filter stays off.
    <Command shouldFilter={false}>
      {/* Radix focuses a popover's contents once, when it opens. On the first
          open only the loading placeholder exists then, so ask for focus here. */}
      <CommandInput
        aria-label="Search notebook labels"
        autoFocus
        onValueChange={setQuery}
        placeholder="Search labels…"
        value={query}
      />
      <CommandList className="max-h-none">
        <CommandEmpty>No matching labels.</CommandEmpty>
        {text ? (
          names.length > 0 && (
            <CommandGroup>
              <FilterItem
                checked={
                  filter.kind === "search" &&
                  filter.text.toLowerCase() === text.toLowerCase()
                }
                count={countRunsWithNameContaining(options, text)}
                onSelect={() => onSelect({ kind: "search", text })}
                value="search"
              >
                Labels containing “{text}”
              </FilterItem>
            </CommandGroup>
          )
        ) : (
          <>
            <CommandGroup>
              <FilterItem
                checked={filter.kind === "all"}
                onSelect={() => onSelect({ kind: "all" })}
                value="all"
              >
                All
              </FilterItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <FilterItem
                checked={filter.kind === "has_link"}
                onSelect={() => onSelect({ kind: "has_link" })}
                value="has_link"
              >
                Has a link
              </FilterItem>
              <FilterItem
                checked={filter.kind === "no_link"}
                onSelect={() => onSelect({ kind: "no_link" })}
                value="no_link"
              >
                No link
              </FilterItem>
            </CommandGroup>
          </>
        )}
        {names.length > 0 && (
          <>
            <CommandSeparator />
            {/* Only the names scroll, so All and the link choices stay put. */}
            <CommandGroup className="max-h-48 overflow-y-auto overscroll-contain">
              {names.map((entry) => (
                <FilterItem
                  checked={filter.kind === "name" && filter.name === entry.name}
                  count={entry.runCount}
                  key={entry.name}
                  onSelect={() => onSelect({ kind: "name", name: entry.name })}
                  value={`name:${entry.name}`}
                >
                  <Highlight
                    className="rounded-[2px] bg-blue-400/30 text-foreground"
                    query={text}
                    text={entry.name}
                  />
                </FilterItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}

function FilterItem({
  checked,
  children,
  count,
  onSelect,
  value,
}: {
  checked: boolean;
  children: ReactNode;
  count?: number;
  onSelect: () => void;
  value: string;
}) {
  return (
    <CommandItem aria-checked={checked} onSelect={onSelect} value={value}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && (
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      )}
      {/* Always takes its space, so the counts line up down the menu. */}
      <Check
        aria-hidden="true"
        className={cn("size-4", checked ? "opacity-100" : "opacity-0")}
      />
    </CommandItem>
  );
}
