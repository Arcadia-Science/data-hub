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
import type { NotebookFilterOption } from "@/lib/api/notebooks";
import {
  type NotebookFilter,
  narrowNotebookOptions,
} from "@/lib/runs/notebook-filter";
import { cn } from "@/lib/utils";

// Lives in its own module so a runs table loads the command menu library only
// when the "Lab Notebook" menu opens.
export function NotebookLinkFilterList({
  filter,
  onSelect,
  options,
}: {
  filter: NotebookFilter;
  onSelect: (filter: NotebookFilter) => void;
  options: NotebookFilterOption[];
}) {
  const [query, setQuery] = useState("");
  const text = query.trim();
  const notebooks = narrowNotebookOptions(options, text);

  return (
    // Matching is by substring, so cmdk's fuzzy filter stays off.
    <Command shouldFilter={false}>
      {/* Radix focuses a popover's contents once, when it opens. On the first
          open only the loading placeholder exists then, so ask for focus here. */}
      <CommandInput
        aria-label="Search lab notebooks"
        autoFocus
        onValueChange={setQuery}
        placeholder="Search lab notebooks…"
        value={query}
      />
      <CommandList className="max-h-none">
        <CommandEmpty>No matching lab notebooks.</CommandEmpty>
        {text ? null : (
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
                checked={filter.kind === "has_lab_notebook"}
                onSelect={() => onSelect({ kind: "has_lab_notebook" })}
                value="has_lab_notebook"
              >
                In any lab notebook
              </FilterItem>
              <FilterItem
                checked={filter.kind === "no_notebook"}
                onSelect={() => onSelect({ kind: "no_notebook" })}
                value="no_notebook"
              >
                In no lab notebook
              </FilterItem>
            </CommandGroup>
          </>
        )}
        {notebooks.length > 0 && (
          <>
            {text ? null : <CommandSeparator />}
            {/* Only the notebooks scroll, so All and the other choices stay
                put. */}
            <CommandGroup className="max-h-48 overflow-y-auto overscroll-contain">
              {notebooks.map((notebook) => (
                <FilterItem
                  checked={
                    filter.kind === "notebook" && filter.id === notebook.id
                  }
                  count={notebook.runCount}
                  key={notebook.id}
                  onSelect={() =>
                    onSelect({ kind: "notebook", id: notebook.id })
                  }
                  value={`notebook:${notebook.id}`}
                >
                  <Highlight
                    className="rounded-[2px] bg-blue-400/30 text-foreground"
                    query={text}
                    text={notebook.name}
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
      {/* A row's count ends where the other rows' check marks do, so the check
          on a counted row sits before its count, and only while checked. */}
      <Check
        aria-hidden="true"
        className={cn(
          "size-4",
          checked ? "opacity-100" : "opacity-0",
          count !== undefined && !checked && "hidden"
        )}
      />
      {count !== undefined && (
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      )}
    </CommandItem>
  );
}
