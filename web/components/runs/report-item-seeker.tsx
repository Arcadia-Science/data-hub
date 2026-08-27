"use client";

import { Check, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useReportItemsContext } from "@/components/runs/report-items-provider";
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
import type {
  ReportItemKind,
  SeekerActions,
  SeekerState,
} from "@/lib/runs/report-items";
import { cn } from "@/lib/utils";

export interface SeekerLabels {
  empty: string;
  next: string;
  previous: string;
  search: string;
  select: string;
}

const LABELS: Record<ReportItemKind, SeekerLabels> = {
  image: {
    empty: "No images found.",
    next: "Next image",
    previous: "Previous image",
    search: "Search images...",
    select: "Select an image\u2026",
  },
  pdf: {
    empty: "No PDFs found.",
    next: "Next PDF",
    previous: "Previous PDF",
    search: "Search PDFs...",
    select: "Select a PDF\u2026",
  },
  spectrum: {
    empty: "No spectra found.",
    next: "Next spectrum",
    previous: "Previous spectrum",
    search: "Search spectra...",
    select: "Select a spectrum\u2026",
  },
  video: {
    empty: "No videos found.",
    next: "Next video",
    previous: "Previous video",
    search: "Search videos...",
    select: "Select a video\u2026",
  },
};

function LoadSentinel({
  listRef,
  onVisible,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  onVisible: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisible();
        }
      },
      { root: listRef.current, rootMargin: "120px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [listRef, onVisible]);

  return (
    <div className="py-2 text-center text-muted-foreground text-xs" ref={ref}>
      {"Loading more\u2026"}
    </div>
  );
}

function ItemPicker({
  actions,
  labels,
  state,
}: {
  actions: SeekerActions;
  labels: SeekerLabels;
  state: SeekerState;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // The search box lives inside the popover, so a filter left applied on close
  // would silently cap prev/next with nothing on screen explaining why.
  function close(anchorId?: number) {
    setOpen(false);
    actions.clearSearch(anchorId);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setHighlight(state.selectedItem?.filename ?? "");
      setOpen(true);
      return;
    }
    close();
  }

  // cmdk highlights the first row unless we pass `value`. A 96-well plate
  // then looks like A1–A9 with no scrollbar, even though the rest are below.
  useLayoutEffect(() => {
    if (!(open && highlight)) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const selected = listRef.current?.querySelector(
        `[data-slot="command-item"][data-value="${CSS.escape(highlight)}"]`
      );
      selected?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [highlight, open]);

  return (
    <Popover modal onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className="w-full max-w-md justify-between font-normal"
          role="combobox"
          variant="outline"
        >
          <span className="truncate">
            {state.selectedItem ? state.selectedItem.filename : labels.select}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onWheel={(event) => event.stopPropagation()}
      >
        {/* Matching happens in Postgres against the whole run, so cmdk must
            not re-filter the window it is handed. */}
        <Command
          onValueChange={setHighlight}
          shouldFilter={false}
          value={highlight}
        >
          <CommandInput
            onValueChange={actions.setSearch}
            placeholder={labels.search}
            value={state.search}
          />
          <CommandList
            className="overscroll-contain"
            onWheel={(event) => event.stopPropagation()}
            ref={listRef}
          >
            <CommandEmpty>
              {state.error ??
                (state.isLoading ? "Loading\u2026" : labels.empty)}
            </CommandEmpty>
            {state.hasPrevious && (
              <LoadSentinel
                listRef={listRef}
                onVisible={actions.loadPrevious}
              />
            )}
            <CommandGroup>
              {state.items.map((item) => (
                <CommandItem
                  key={item.id}
                  onSelect={() => {
                    actions.selectId(item.id);
                    close(item.id);
                  }}
                  value={item.filename}
                >
                  <Check
                    className={cn(
                      "mr-2 size-4",
                      item.id === state.selectedItem?.id
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                  <span className="truncate">{item.filename}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {state.hasMore && (
              <LoadSentinel listRef={listRef} onVisible={actions.loadMore} />
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Shared report-data toolbar: filename combobox on the left, position and
// prev/next seek on the right — same layout for every report viewer.
export function SeekerToolbar({
  actions,
  labels,
  state,
}: {
  actions: SeekerActions;
  labels: SeekerLabels;
  state: SeekerState;
}) {
  const canGoPrev = state.selectedIndex > 0;
  const canGoNext = state.selectedIndex + 1 < state.total;

  return (
    <div className="flex items-center justify-between gap-2">
      <ItemPicker actions={actions} labels={labels} state={state} />
      <div className="flex items-center gap-2">
        {state.total > 0 && (
          <span className="whitespace-nowrap font-mono text-muted-foreground text-xs">
            {state.selectedIndex + 1} / {state.total}
          </span>
        )}
        <div className="flex items-center gap-1">
          <Button
            aria-label={labels.previous}
            disabled={!canGoPrev}
            onClick={actions.previous}
            size="icon"
            variant="outline"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            aria-label={labels.next}
            disabled={!canGoNext}
            onClick={actions.next}
            size="icon"
            variant="outline"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ReportItemSeeker() {
  const { state, actions, meta } = useReportItemsContext();
  return (
    <SeekerToolbar actions={actions} labels={LABELS[meta.kind]} state={state} />
  );
}
