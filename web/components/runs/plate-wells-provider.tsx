"use client";

import { createContext, type ReactNode, use, useMemo, useState } from "react";
import { compareWells } from "@/lib/runs/plate-wells";
import type {
  ReportItem,
  SeekerActions,
  SeekerState,
} from "@/lib/runs/report-items";

export interface PlateWellsActions extends SeekerActions {
  selectWell: (well: string) => void;
}

// Held as a label rather than a positional id so a caller that swaps the well
// list (a qPCR channel change) keeps the same well selected.
interface Selection {
  search: string;
  selectedWell: string;
}

// Actions and state are separate so a plate grid, which only ever calls
// `selectWell`, does not re-render every time the selection moves.
const PlateWellsActionsContext = createContext<PlateWellsActions | null>(null);
const PlateWellsStateContext = createContext<SeekerState | null>(null);

function filterWells(ordered: ReportItem[], search: string): ReportItem[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return ordered;
  }
  return ordered.filter((item) => item.filename.toLowerCase().includes(query));
}

// Owns "which well is selected" for one plate. `wells` is a list of labels, so
// any instrument's well shape works as long as the caller keeps the array
// identity stable.
export function PlateWellsProvider({
  children,
  wells,
}: {
  children: ReactNode;
  wells: readonly string[];
}) {
  const ordered = useMemo<ReportItem[]>(() => {
    const unique = [...new Set(wells)];
    unique.sort(compareWells);
    return unique.map((well, index) => ({ id: index + 1, filename: well }));
  }, [wells]);

  const wellById = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of ordered) {
      map.set(item.id, item.filename);
    }
    return map;
  }, [ordered]);

  const [selection, setSelection] = useState<Selection>(() => ({
    search: "",
    selectedWell: ordered[0]?.filename ?? "",
  }));

  // Every action updates through the setter callback, so this object only
  // changes when the well list itself changes.
  const actions = useMemo<PlateWellsActions>(() => {
    function seek(current: Selection, delta: number): Selection {
      const visible = filterWells(ordered, current.search);
      const from = visible.findIndex(
        (item) => item.filename === current.selectedWell
      );
      const next = (from < 0 ? 0 : from) + delta;
      if (next < 0 || next >= visible.length) {
        return current;
      }
      return { ...current, selectedWell: visible[next].filename };
    }

    function selectWell(well: string) {
      setSelection((current) =>
        current.selectedWell === well
          ? current
          : { ...current, selectedWell: well }
      );
    }

    return {
      clearSearch: (anchorId?: number) =>
        setSelection((current) => ({
          search: "",
          selectedWell:
            (anchorId === undefined ? undefined : wellById.get(anchorId)) ??
            current.selectedWell,
        })),
      loadMore: () => undefined,
      loadPrevious: () => undefined,
      next: () => setSelection((current) => seek(current, 1)),
      previous: () => setSelection((current) => seek(current, -1)),
      selectId: (id: number) => {
        const well = wellById.get(id);
        if (well !== undefined) {
          selectWell(well);
        }
      },
      selectWell,
      setSearch: (search: string) =>
        setSelection((current) => ({ ...current, search })),
    };
  }, [ordered, wellById]);

  const state = useMemo<SeekerState>(() => {
    const items = filterWells(ordered, selection.search);
    const index = items.findIndex(
      (item) => item.filename === selection.selectedWell
    );
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
    <PlateWellsActionsContext.Provider value={actions}>
      <PlateWellsStateContext.Provider value={state}>
        {children}
      </PlateWellsStateContext.Provider>
    </PlateWellsActionsContext.Provider>
  );
}

export function usePlateWellsActions(): PlateWellsActions {
  const context = use(PlateWellsActionsContext);
  if (!context) {
    throw new Error(
      "usePlateWellsActions must be used within a <PlateWellsProvider>"
    );
  }
  return context;
}

export function usePlateWellsState(): SeekerState {
  const context = use(PlateWellsStateContext);
  if (!context) {
    throw new Error(
      "usePlateWellsState must be used within a <PlateWellsProvider>"
    );
  }
  return context;
}
