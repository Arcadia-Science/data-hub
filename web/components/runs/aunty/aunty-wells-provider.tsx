"use client";

import { createContext, type ReactNode, use, useMemo, useState } from "react";
import type { UseReportItemsResult } from "@/hooks/use-report-items";
import { compareWells } from "@/lib/runs/aunty";
import type { ReportItem } from "@/lib/runs/report-items";

export interface AuntyWellsContextValue extends UseReportItemsResult {
  selectWell: (well: string) => void;
}

const AuntyWellsContext = createContext<AuntyWellsContextValue | null>(null);

export function AuntyWellsProvider({
  children,
  initialWell,
  wells,
}: {
  children: ReactNode;
  initialWell?: string;
  wells: string[];
}) {
  const ordered = useMemo(() => {
    const unique = [...new Set(wells)];
    unique.sort(compareWells);
    return unique.map((well, index) => ({
      id: index + 1,
      filename: well,
    }));
  }, [wells]);

  const idByWell = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of ordered) {
      map.set(item.filename, item.id);
    }
    return map;
  }, [ordered]);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number>(
    () =>
      (initialWell ? idByWell.get(initialWell) : undefined) ??
      ordered[0]?.id ??
      0
  );

  const query = search.trim().toLowerCase();
  const items = useMemo(() => {
    if (!query) {
      return ordered;
    }
    return ordered.filter((item) =>
      item.filename.toLowerCase().includes(query)
    );
  }, [ordered, query]);

  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId)
  );
  const selectedItem: ReportItem | null =
    items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  const value = useMemo<AuntyWellsContextValue>(() => {
    function selectWell(well: string) {
      const id = idByWell.get(well);
      if (id !== undefined) {
        setSelectedId(id);
      }
    }

    function seek(delta: number) {
      const current = items.findIndex((item) => item.id === selectedId);
      const from = current >= 0 ? current : 0;
      const next = from + delta;
      if (next < 0 || next >= items.length) {
        return;
      }
      setSelectedId(items[next].id);
    }

    return {
      selectWell,
      state: {
        error: null,
        hasMore: false,
        hasPrevious: false,
        isLoading: false,
        items,
        search,
        selectedIndex: selectedItem ? selectedIndex : 0,
        selectedItem,
        total: items.length,
      },
      actions: {
        clearSearch: (anchorId?: number) => {
          setSearch("");
          if (anchorId !== undefined) {
            setSelectedId(anchorId);
          }
        },
        loadMore: () => undefined,
        loadPrevious: () => undefined,
        next: () => seek(1),
        previous: () => seek(-1),
        selectId: (id: number) => setSelectedId(id),
        setSearch,
      },
    };
  }, [idByWell, items, search, selectedId, selectedIndex, selectedItem]);

  return (
    <AuntyWellsContext.Provider value={value}>
      {children}
    </AuntyWellsContext.Provider>
  );
}

export function useAuntyWells(): AuntyWellsContextValue {
  const context = use(AuntyWellsContext);
  if (!context) {
    throw new Error(
      "useAuntyWells must be used within an <AuntyWellsProvider>"
    );
  }
  return context;
}
