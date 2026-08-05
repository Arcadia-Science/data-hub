"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { BreadcrumbItem } from "@/components/ui/breadcrumb";
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
import { useRecentRuns } from "@/hooks/use-recent-runs";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { cn } from "@/lib/utils";

interface RunSearchRow {
  instrumentDisplayName: string;
  instrumentId: string;
  runId: string;
}

interface RunListResponse {
  data: Array<{
    instrument_display_name: string;
    instrument_id: string;
    run_id: string;
  }>;
}

const SEARCH_DEBOUNCE_MS = 250;

function toRunHref(instrumentId: string, runId: string): string {
  return `/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}`;
}

export function RunSwitcher({ run }: { run: RunDetail }) {
  const router = useRouter();
  const { recent, recordVisit } = useRecentRuns();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RunSearchRow[]>([]);
  const [recentRuns, setRecentRuns] = useState<RunSearchRow[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingRecentRuns, setIsLoadingRecentRuns] = useState(false);

  useEffect(() => {
    recordVisit({
      instrumentId: run.instrumentId,
      runId: run.runId,
      instrumentDisplayName: run.instrumentDisplayName,
      visitedAt: Date.now(),
    });
  }, [recordVisit, run.instrumentDisplayName, run.instrumentId, run.runId]);

  const recentlyViewed = useMemo(
    () =>
      recent
        .filter((entry) => entry.instrumentId === run.instrumentId)
        .slice(0, 10)
        .map((entry) => ({
          instrumentId: entry.instrumentId,
          runId: entry.runId,
          instrumentDisplayName: entry.instrumentDisplayName,
        })),
    [recent, run.instrumentId]
  );

  const recentlyViewedKeys = useMemo(
    () =>
      new Set(
        recentlyViewed.map((entry) => `${entry.instrumentId}:${entry.runId}`)
      ),
    [recentlyViewed]
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSearchResults([]);
      setRecentRuns([]);
      setIsSearching(false);
      setIsLoadingRecentRuns(false);
      return;
    }

    if (query.trim()) {
      setRecentRuns([]);
      setIsLoadingRecentRuns(false);

      const controller = new AbortController();
      const timeoutId = window.setTimeout(async () => {
        setIsSearching(true);
        try {
          const params = new URLSearchParams({
            instrument_id: run.instrumentId,
            search: query.trim(),
            per_page: "10",
          });
          const res = await fetch(
            `/api/v1/instrument-runs?${params.toString()}`,
            { signal: controller.signal }
          );
          if (!res.ok) {
            setSearchResults([]);
            return;
          }
          const body = (await res.json()) as RunListResponse;
          setSearchResults(
            body.data.map((row) => ({
              instrumentId: row.instrument_id,
              runId: row.run_id,
              instrumentDisplayName: row.instrument_display_name,
            }))
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setSearchResults([]);
        } finally {
          if (!controller.signal.aborted) {
            setIsSearching(false);
          }
        }
      }, SEARCH_DEBOUNCE_MS);

      return () => {
        controller.abort();
        window.clearTimeout(timeoutId);
      };
    }

    setSearchResults([]);
    setIsSearching(false);

    const controller = new AbortController();
    setIsLoadingRecentRuns(true);

    void (async () => {
      try {
        const params = new URLSearchParams({
          instrument_id: run.instrumentId,
          per_page: "10",
          sort: "acquired_at",
          order: "desc",
        });
        const res = await fetch(
          `/api/v1/instrument-runs?${params.toString()}`,
          { signal: controller.signal }
        );
        if (!res.ok) {
          setRecentRuns([]);
          return;
        }
        const body = (await res.json()) as RunListResponse;
        setRecentRuns(
          body.data.map((row) => ({
            instrumentId: row.instrument_id,
            runId: row.run_id,
            instrumentDisplayName: row.instrument_display_name,
          }))
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setRecentRuns([]);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingRecentRuns(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, query, run.instrumentId]);

  const recentRunsForInstrument = useMemo(
    () =>
      recentRuns.filter(
        (entry) =>
          !recentlyViewedKeys.has(`${entry.instrumentId}:${entry.runId}`)
      ),
    [recentRuns, recentlyViewedKeys]
  );

  function selectRun(instrumentId: string, runId: string) {
    setOpen(false);
    if (instrumentId === run.instrumentId && runId === run.runId) {
      return;
    }
    router.push(toRunHref(instrumentId, runId));
  }

  function renderRunItem(item: RunSearchRow) {
    const isActive =
      item.instrumentId === run.instrumentId && item.runId === run.runId;
    return (
      <CommandItem
        data-checked={isActive}
        key={`${item.instrumentId}:${item.runId}`}
        onSelect={() => selectRun(item.instrumentId, item.runId)}
        value={item.runId}
      >
        <Check
          className={cn(
            "size-4 shrink-0",
            isActive ? "opacity-100" : "opacity-0"
          )}
        />
        <span className="truncate font-mono">{item.runId}</span>
      </CommandItem>
    );
  }

  const hasRecentlyViewed = recentlyViewed.length > 0;
  const hasRecentRuns = recentRunsForInstrument.length > 0;
  const showEmptyState = !(
    query.trim() ||
    hasRecentlyViewed ||
    hasRecentRuns ||
    isLoadingRecentRuns
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <BreadcrumbItem>
        <PopoverTrigger asChild>
          <button
            aria-expanded={open}
            aria-label="Switch run"
            className="inline-flex cursor-pointer items-center gap-1 font-mono font-normal text-foreground transition-colors hover:text-foreground/80"
            role="combobox"
            type="button"
          >
            <span aria-current="page" className="font-mono">
              {run.runId}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
      </BreadcrumbItem>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setQuery}
            placeholder="Search runs..."
            value={query}
          />
          <CommandList>
            {query.trim() ? (
              isSearching ? (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  Searching...
                </div>
              ) : searchResults.length === 0 ? (
                <CommandEmpty>No matching runs.</CommandEmpty>
              ) : (
                <CommandGroup heading="Results">
                  {searchResults.map((item) => renderRunItem(item))}
                </CommandGroup>
              )
            ) : (
              <>
                {showEmptyState ? (
                  <CommandEmpty>No recent runs.</CommandEmpty>
                ) : null}
                {hasRecentlyViewed ? (
                  <CommandGroup heading="Recently viewed">
                    {recentlyViewed.map((item) => renderRunItem(item))}
                  </CommandGroup>
                ) : null}
                {isLoadingRecentRuns ? (
                  <div className="py-4 text-center text-muted-foreground text-sm">
                    Loading recent runs...
                  </div>
                ) : hasRecentRuns ? (
                  <CommandGroup heading="Recent runs">
                    {recentRunsForInstrument.map((item) => renderRunItem(item))}
                  </CommandGroup>
                ) : null}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
