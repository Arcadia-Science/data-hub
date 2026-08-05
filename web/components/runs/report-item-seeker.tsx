"use client";

import { Check, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface ReportSeekItem {
  filename: string;
  id: number;
}

function ItemPicker({
  items,
  selectedId,
  onSelect,
  selectPlaceholder,
  searchPlaceholder,
  emptyMessage,
}: {
  items: ReportSeekItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  selectPlaceholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((item) => item.id === selectedId);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full max-w-md justify-between font-normal"
          role="combobox"
          variant="outline"
        >
          <span className="truncate">
            {selected ? selected.filename : selectPlaceholder}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => {
                const isSelected = item.id === selectedId;
                return (
                  <CommandItem
                    key={item.id}
                    onSelect={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                    value={item.filename}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        isSelected ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{item.filename}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Shared report-data toolbar: filename combobox on the left, prev/next seek on
// the right — same layout for image and Raman spectrum viewers.
export function ReportItemSeeker({
  items,
  selectedId,
  onSelect,
  selectPlaceholder,
  searchPlaceholder,
  emptyMessage,
  previousAriaLabel,
  nextAriaLabel,
}: {
  items: ReportSeekItem[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  selectPlaceholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  previousAriaLabel: string;
  nextAriaLabel: string;
}) {
  const currentIndex =
    selectedId == null ? -1 : items.findIndex((item) => item.id === selectedId);
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < items.length - 1;

  return (
    <div className="flex items-center justify-between gap-2">
      <ItemPicker
        emptyMessage={emptyMessage}
        items={items}
        onSelect={onSelect}
        searchPlaceholder={searchPlaceholder}
        selectedId={selectedId}
        selectPlaceholder={selectPlaceholder}
      />
      <div className="flex items-center gap-1">
        <Button
          aria-label={previousAriaLabel}
          disabled={!canGoPrev}
          onClick={() => {
            if (!canGoPrev) {
              return;
            }
            onSelect(items[currentIndex - 1].id);
          }}
          size="icon"
          variant="outline"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          aria-label={nextAriaLabel}
          disabled={!canGoNext}
          onClick={() => {
            if (!canGoNext) {
              return;
            }
            onSelect(items[currentIndex + 1].id);
          }}
          size="icon"
          variant="outline"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
