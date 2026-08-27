"use client";

import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { type AuntyWell, compareWells } from "@/lib/runs/aunty";
import type {
  ReportItem,
  SeekerActions,
  SeekerState,
} from "@/lib/runs/report-items";

export interface AuntyWellsActions extends SeekerActions {
  selectWell: (well: string) => void;
}

interface Selection {
  search: string;
  selectedId: number;
}

// Actions and state are separate so the plate grid, which only ever calls
// `selectWell`, does not re-render every time the selection moves.
const AuntyWellsActionsContext = createContext<AuntyWellsActions | null>(null);
const AuntyWellsStateContext = createContext<SeekerState | null>(null);

function filterWells(ordered: ReportItem[], search: string): ReportItem[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return ordered;
  }
  return ordered.filter((item) => item.filename.toLowerCase().includes(query));
}

export function AuntyWellsProvider({
  children,
  wells,
}: {
  children: ReactNode;
  wells: AuntyWell[];
}) {
  const ordered = useMemo<ReportItem[]>(() => {
    const unique = [...new Set(wells.map((well) => well.well))];
    unique.sort(compareWells);
    return unique.map((well, index) => ({ id: index + 1, filename: well }));
  }, [wells]);

  const idByWell = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of ordered) {
      map.set(item.filename, item.id);
    }
    return map;
  }, [ordered]);

  const [selection, setSelection] = useState<Selection>(() => ({
    search: "",
    selectedId: ordered[0]?.id ?? 0,
  }));

  // Every action updates through the setter callback, so this object only
  // changes when the well list itself changes.
  const actions = useMemo<AuntyWellsActions>(() => {
    function seek(current: Selection, delta: number): Selection {
      const visible = filterWells(ordered, current.search);
      const from = visible.findIndex((item) => item.id === current.selectedId);
      const next = (from < 0 ? 0 : from) + delta;
      if (next < 0 || next >= visible.length) {
        return current;
      }
      return { ...current, selectedId: visible[next].id };
    }

    return {
      clearSearch: (anchorId?: number) =>
        setSelection((current) => ({
          search: "",
          selectedId: anchorId ?? current.selectedId,
        })),
      loadMore: () => undefined,
      loadPrevious: () => undefined,
      next: () => setSelection((current) => seek(current, 1)),
      previous: () => setSelection((current) => seek(current, -1)),
      selectId: (id: number) =>
        setSelection((current) => ({ ...current, selectedId: id })),
      selectWell: (well: string) => {
        const id = idByWell.get(well);
        if (id !== undefined) {
          setSelection((current) => ({ ...current, selectedId: id }));
        }
      },
      setSearch: (search: string) =>
        setSelection((current) => ({ ...current, search })),
    };
  }, [idByWell, ordered]);

  const state = useMemo<SeekerState>(() => {
    const items = filterWells(ordered, selection.search);
    const index = items.findIndex((item) => item.id === selection.selectedId);
    return {
      error: null,
      hasMore: false,
      hasPrevious: false,
      isLoading: false,
      items,
      search: selection.search,
      selectedIndex: Math.max(0, index),
      selectedItem: (index >= 0 ? items[index] : items[0]) ?? null,
      total: items.length,
    };
  }, [ordered, selection]);

  return (
    <AuntyWellsActionsContext.Provider value={actions}>
      <AuntyWellsStateContext.Provider value={state}>
        {children}
      </AuntyWellsStateContext.Provider>
    </AuntyWellsActionsContext.Provider>
  );
}

export function useAuntyWellsActions(): AuntyWellsActions {
  const context = use(AuntyWellsActionsContext);
  if (!context) {
    throw new Error(
      "useAuntyWellsActions must be used within an <AuntyWellsProvider>"
    );
  }
  return context;
}

export function useAuntyWellsState(): SeekerState {
  const context = use(AuntyWellsStateContext);
  if (!context) {
    throw new Error(
      "useAuntyWellsState must be used within an <AuntyWellsProvider>"
    );
  }
  return context;
}
