"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  REPORT_ITEMS_WINDOW,
  type ReportItem,
  type ReportItemKind,
  type ReportItemsPage,
  type SeekerSource,
} from "@/lib/runs/report-items";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

const SEARCH_DEBOUNCE_MS = 300;

const EMPTY_ITEMS: ReportItem[] = [];

// A contiguous run of the server-ordered list starting at absolute index
// `offset`. Extends both ways so an anchored match can still be seeked away.
interface CacheEntry {
  items: ReportItem[];
  offset: number;
  total: number;
}

interface Selection {
  index: number;
  query: string;
}

export interface UseReportItemsOptions {
  fetchReportItems: ReportDataSource["fetchReportItems"];
  initialPage: ReportItemsPage;
  kind: ReportItemKind;
}

export type UseReportItemsResult = SeekerSource;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to load report items";
}

export function useReportItems({
  fetchReportItems,
  initialPage,
  kind,
}: UseReportItemsOptions): UseReportItemsResult {
  const [cache, setCache] = useState<Record<string, CacheEntry>>(() => ({
    "": {
      items: initialPage.data,
      offset: initialPage.pagination.offset,
      total: initialPage.pagination.total,
    },
  }));
  const [search, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>({
    index: 0,
    query: "",
  });
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busyControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => busyControllerRef.current?.abort(), []);

  const entry = cache[query];
  const items = entry?.items ?? EMPTY_ITEMS;
  const offset = entry?.offset ?? 0;
  const total = entry?.total ?? 0;
  const hasMore = offset + items.length < total;
  const hasPrevious = offset > 0;
  // A query with no cache entry is either in flight or about to be, so the
  // dropdown shows a loading state without an extra state write.
  const isLoading = entry === undefined || isBusy;
  const selectedIndex = selection.query === query ? selection.index : 0;
  const selectedItem = items[selectedIndex - offset] ?? null;

  const fetchWindow = useCallback(
    (
      params: {
        anchor?: number;
        offset: number;
        search: string;
      },
      signal: AbortSignal
    ): Promise<ReportItemsPage> =>
      fetchReportItems({
        kind,
        offset: params.offset,
        limit: REPORT_ITEMS_WINDOW,
        search: params.search || undefined,
        anchor: params.anchor,
        signal,
      }),
    [fetchReportItems, kind]
  );

  useEffect(() => {
    if (search === query) {
      return;
    }
    const timer = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  const hasEntry = entry !== undefined;
  useEffect(() => {
    if (hasEntry) {
      return;
    }
    const controller = new AbortController();
    fetchWindow({ offset: 0, search: query }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) {
          return;
        }
        setCache((prev) => ({
          ...prev,
          [query]: {
            items: page.data,
            offset: page.pagination.offset,
            total: page.pagination.total,
          },
        }));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(err));
        }
      });
    return () => controller.abort();
  }, [fetchWindow, hasEntry, query]);

  // Extends the loaded window in one direction. Returns the resulting entry so
  // callers can select an index that was not loaded when they started.
  const extend = useCallback(
    async (direction: "forward" | "back"): Promise<CacheEntry | null> => {
      if (!entry || isBusy) {
        return entry ?? null;
      }
      const isForward = direction === "forward";
      if (isForward ? !hasMore : !hasPrevious) {
        return entry;
      }

      busyControllerRef.current?.abort();
      const controller = new AbortController();
      busyControllerRef.current = controller;
      setIsBusy(true);
      try {
        const nextOffset = isForward
          ? offset + items.length
          : Math.max(0, offset - REPORT_ITEMS_WINDOW);
        const page = await fetchWindow(
          { offset: nextOffset, search: query },
          controller.signal
        );
        if (controller.signal.aborted) {
          return entry;
        }
        // A backward window clamped at 0 can overlap what is already loaded,
        // so drop the rows it duplicates before joining the two runs.
        const overlap = Math.max(0, nextOffset + page.data.length - offset);
        const merged: CacheEntry = isForward
          ? {
              items: [...items, ...page.data],
              offset,
              // An empty window means the list is shorter than `total`
              // claimed; trust the rows so the sentinel stops refiring.
              total:
                page.data.length === 0
                  ? offset + items.length
                  : page.pagination.total,
            }
          : {
              items: [...page.data, ...items.slice(overlap)],
              offset: nextOffset,
              total: page.pagination.total,
            };
        setCache((prev) => ({ ...prev, [query]: merged }));
        setError(null);
        return merged;
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(errorMessage(err));
        }
        return entry;
      } finally {
        if (!controller.signal.aborted) {
          setIsBusy(false);
        }
      }
    },
    [entry, fetchWindow, hasMore, hasPrevious, isBusy, items, offset, query]
  );

  const select = useCallback(
    (index: number) => setSelection({ index, query }),
    [query]
  );

  const seek = useCallback(
    (delta: number) => {
      const target = selectedIndex + delta;
      if (target < 0 || target >= total) {
        return;
      }
      if (target >= offset && target < offset + items.length) {
        select(target);
        return;
      }
      void extend(delta > 0 ? "forward" : "back").then((loaded) => {
        if (!loaded) {
          return;
        }
        if (
          target >= loaded.offset &&
          target < loaded.offset + loaded.items.length
        ) {
          select(target);
        }
      });
    },
    [extend, items.length, offset, select, selectedIndex, total]
  );

  const next = useCallback(() => seek(1), [seek]);
  const previous = useCallback(() => seek(-1), [seek]);
  const loadMore = useCallback(() => void extend("forward"), [extend]);
  const loadPrevious = useCallback(() => void extend("back"), [extend]);

  const selectId = useCallback(
    (id: number) => {
      const index = items.findIndex((item) => item.id === id);
      if (index >= 0) {
        select(offset + index);
      }
    },
    [items, offset, select]
  );

  // Drops the filter while keeping the selection, so prev/next walk the whole
  // run again. Mid-selection callers pass the id the closure cannot see yet.
  const clearSearch = useCallback(
    (anchorId?: number) => {
      const anchor = anchorId ?? selectedItem?.id;
      if (query === "" || anchor === undefined) {
        setSearchInput("");
        setQuery("");
        return;
      }

      // Shares the extend controller: both load one window for the current
      // query, so the later action should cancel the earlier one, and unmount
      // cancels whichever is outstanding.
      busyControllerRef.current?.abort();
      const controller = new AbortController();
      busyControllerRef.current = controller;
      void fetchWindow({ anchor, offset: 0, search: "" }, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) {
            return;
          }
          setCache((prev) => ({
            ...prev,
            "": {
              items: page.data,
              offset: page.pagination.offset,
              total: page.pagination.total,
            },
          }));
          setSelection({
            index: page.pagination.anchor_index ?? 0,
            query: "",
          });
          setSearchInput("");
          setQuery("");
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(err));
          }
        });
    },
    [fetchWindow, query, selectedItem]
  );

  return {
    state: {
      error,
      hasMore,
      hasPrevious,
      isLoading,
      items,
      search,
      selectedIndex,
      selectedItem,
      total,
    },
    actions: {
      clearSearch,
      loadMore,
      loadPrevious,
      next,
      previous,
      selectId,
      setSearch: setSearchInput,
    },
  };
}
