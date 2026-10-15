"use client";

import { useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useMemo, useState } from "react";
import { SelectionNotice } from "@/components/selection-notice";
import { isRunListScopeParam, selectionScopeKey } from "@/lib/selection-scope";

export interface RunCaps {
  delete: boolean;
  download: boolean;
  reprocess: boolean;
  upload: boolean;
}

// Minimal per-row counts the bulk bar needs to populate confirmation
// dialogs without refetching — covers the "soft-delete 4 runs and their
// 44 files" and "reprocess 12 eligible files" messaging.
export interface RunStats {
  fileCount: number;
  filesCompleted: number;
  filesFailed: number;
  reprocessableFileCount: number;
}

export interface RunRef {
  caps: RunCaps;
  id: string;
  instrumentId: string;
  runId: string;
  stats: RunStats;
}

// Explicit context interface: state / actions / meta. Consumers never touch
// the underlying useState — we can swap implementations (e.g. move to URL
// state, redux, etc.) without changing any consumer.
interface RunSelectionContextValue {
  actions: {
    toggle: (ref: RunRef) => void;
    selectMany: (refs: RunRef[]) => void;
    clear: () => void;
  };
  meta: {
    count: number;
    isSelected: (runInternalId: string) => boolean;
    allSelected: (refs: RunRef[]) => boolean;
    // Capability roll-ups: true iff every selected run supports the action.
    // Consumers use these to hide bulk buttons when the selection is mixed
    // — e.g. one run still needs upload and another is already uploaded.
    allCanUpload: boolean;
    allCanDownload: boolean;
    allCanReprocess: boolean;
    allCanDelete: boolean;
  };
  state: { selected: ReadonlyMap<string, RunRef> };
}

const SELECTION_CLEARED_NOTICE =
  "Selection cleared because the list of runs changed.";

const RunSelectionContext = createContext<RunSelectionContextValue | null>(
  null
);

export function RunSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const scopeKey = selectionScopeKey(searchParams, isRunListScopeParam);
  const [store, setStore] = useState(() => ({
    scopeKey,
    selected: new Map<string, RunRef>(),
    notice: "",
  }));

  // A new search, filter, or sort lists different runs, so picks made on the old
  // list could be off screen. Dropping them keeps Delete and Reprocess away from
  // runs the user is not looking at. Another page of the same results keeps them.
  if (store.scopeKey !== scopeKey) {
    setStore({
      scopeKey,
      selected: new Map(),
      notice: store.selected.size > 0 ? SELECTION_CLEARED_NOTICE : "",
    });
  }
  const selected = store.selected;

  const setSelected = useCallback(
    (update: (prev: Map<string, RunRef>) => Map<string, RunRef>) => {
      setStore((prev) => ({
        ...prev,
        selected: update(prev.selected),
        notice: "",
      }));
    },
    []
  );

  const toggle = useCallback(
    (ref: RunRef) => {
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(ref.id)) {
          next.delete(ref.id);
        } else {
          next.set(ref.id, ref);
        }
        return next;
      });
    },
    [setSelected]
  );

  const selectMany = useCallback(
    (refs: RunRef[]) => {
      setSelected((prev) => {
        const next = new Map(prev);
        const alreadyAll = refs.every((r) => next.has(r.id));
        if (alreadyAll) {
          for (const r of refs) {
            next.delete(r.id);
          }
        } else {
          for (const r of refs) {
            next.set(r.id, r);
          }
        }
        return next;
      });
    },
    [setSelected]
  );

  const clear = useCallback(() => {
    setSelected(() => new Map());
  }, [setSelected]);

  const value = useMemo<RunSelectionContextValue>(() => {
    const refs = Array.from(selected.values());
    const count = refs.length;
    return {
      state: { selected },
      actions: { toggle, selectMany, clear },
      meta: {
        count,
        isSelected: (id) => selected.has(id),
        allSelected: (refs) =>
          refs.length > 0 && refs.every((r) => selected.has(r.id)),
        allCanUpload: count > 0 && refs.every((r) => r.caps.upload),
        allCanDownload: count > 0 && refs.every((r) => r.caps.download),
        allCanReprocess: count > 0 && refs.every((r) => r.caps.reprocess),
        allCanDelete: count > 0 && refs.every((r) => r.caps.delete),
      },
    };
  }, [selected, toggle, selectMany, clear]);

  return (
    <RunSelectionContext.Provider value={value}>
      {children}
      <SelectionNotice message={store.notice} />
    </RunSelectionContext.Provider>
  );
}

export function useRunSelection(): RunSelectionContextValue {
  const ctx = use(RunSelectionContext);
  if (!ctx) {
    throw new Error(
      "useRunSelection must be used within a RunSelectionProvider"
    );
  }
  return ctx;
}
