"use client";

import { createContext, use, useCallback, useMemo, useState } from "react";

export type RunRef = {
  id: string;
  instrumentId: string;
  runId: string;
};

// Explicit context interface: state / actions / meta. Consumers never touch
// the underlying useState — we can swap implementations (e.g. move to URL
// state, redux, etc.) without changing any consumer.
type RunSelectionContextValue = {
  state: { selected: ReadonlyMap<string, RunRef> };
  actions: {
    toggle: (ref: RunRef) => void;
    selectMany: (refs: RunRef[]) => void;
    clear: () => void;
  };
  meta: {
    count: number;
    isSelected: (runInternalId: string) => boolean;
    allSelected: (refs: RunRef[]) => boolean;
  };
};

const RunSelectionContext = createContext<RunSelectionContextValue | null>(
  null
);

export function RunSelectionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Map<string, RunRef>>(
    () => new Map()
  );

  const toggle = useCallback((ref: RunRef) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(ref.id)) {
        next.delete(ref.id);
      } else {
        next.set(ref.id, ref);
      }
      return next;
    });
  }, []);

  const selectMany = useCallback((refs: RunRef[]) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const alreadyAll = refs.every((r) => next.has(r.id));
      if (alreadyAll) {
        for (const r of refs) next.delete(r.id);
      } else {
        for (const r of refs) next.set(r.id, r);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Map());
  }, []);

  const value = useMemo<RunSelectionContextValue>(
    () => ({
      state: { selected },
      actions: { toggle, selectMany, clear },
      meta: {
        count: selected.size,
        isSelected: (id) => selected.has(id),
        allSelected: (refs) =>
          refs.length > 0 && refs.every((r) => selected.has(r.id)),
      },
    }),
    [selected, toggle, selectMany, clear]
  );

  return (
    <RunSelectionContext.Provider value={value}>
      {children}
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
